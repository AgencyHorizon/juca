import Fastify from "fastify";
import { config } from "./config.js";
import { adminRoutes } from "./admin/routes.js";
import { parseTelegram, verifyTelegram } from "./channels/telegram.js";
import { handleWhatsAppStatuses, parseWhatsApp, verifyWhatsApp } from "./channels/whatsapp.js";
import { pool } from "./db/pool.js";
import { enqueueInbound } from "./jobs/queue.js";
import { safeEqual } from "./lib/crypto.js";
import { logger } from "./lib/logger.js";
import { registry } from "./lib/metrics.js";
import { redis } from "./lib/redis.js";
import { channels } from "./channels/index.js";
import { channelsOf } from "./core/users.js";
import { handleCallback } from "./integrations/oauth.js";
import { createConnectToken, linkItem } from "./integrations/finance/pluggy.js";
import { query } from "./db/pool.js";

export function buildServer() {
  const app = Fastify({ loggerInstance: logger, bodyLimit: 1_000_000, trustProxy: true });

  // corpo cru é necessário para validar a assinatura HMAC do WhatsApp (RNF-10)
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    try {
      const raw = body as Buffer;
      done(null, { raw, json: raw.length ? JSON.parse(raw.toString("utf8")) : {} });
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    await redis.ping();
    return { ok: true };
  });

  app.get("/metrics", async (req, reply) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!config.ADMIN_TOKEN || !safeEqual(token, config.ADMIN_TOKEN)) return reply.code(401).send();
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });

  // --- Telegram ---
  app.post("/webhooks/telegram", async (req, reply) => {
    if (!verifyTelegram(req.headers)) return reply.code(401).send();
    const { json } = req.body as { json: unknown };
    const msg = parseTelegram(json);
    if (msg) await enqueueInbound(msg);
    return reply.code(200).send({ ok: true });
  });

  // --- WhatsApp Cloud API ---
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && config.WHATSAPP_VERIFY_TOKEN && q["hub.verify_token"] === config.WHATSAPP_VERIFY_TOKEN) {
      return reply.code(200).send(q["hub.challenge"]);
    }
    return reply.code(403).send();
  });

  app.post("/webhooks/whatsapp", async (req, reply) => {
    const { raw, json } = req.body as { raw: Buffer; json: unknown };
    if (!verifyWhatsApp(raw, req.headers["x-hub-signature-256"])) return reply.code(401).send();
    for (const msg of parseWhatsApp(json)) await enqueueInbound(msg);
    handleWhatsAppStatuses(json);
    return reply.code(200).send();
  });

  const notify = async (userId: number, text: string) => {
    const chan = (await channelsOf(userId))[0];
    if (chan) await channels[chan.channel].send(chan.external_id, text).catch((e) => logger.error({ err: e }, "falha ao avisar conexão"));
  };

  // --- OAuth (Gmail + Google Calendar, Outlook) ---
  app.get("/oauth/:provider/callback", async (req, reply) => {
    const provider = (req.params as { provider: string }).provider;
    const q = req.query as { state?: string; code?: string; error?: string };
    reply.type("text/html; charset=utf-8");
    if ((provider !== "google" && provider !== "microsoft") || q.error || !q.state || !q.code) {
      return reply.code(400).send(page("Conexão cancelada", "Nada foi conectado. Se quiser tentar de novo, peça um novo link ao Juca."));
    }
    try {
      const { userId, email } = await handleCallback(provider, q.state, q.code);
      await notify(userId, `Pronto! Conectei ${email} ✅ O que você quer que eu veja primeiro?`);
      return page("Conta conectada ✅", `O Juca agora tem acesso a ${escapeHtml(email)}. Pode voltar pro chat.`);
    } catch (e) {
      logger.error({ err: e }, "falha no callback do OAuth");
      return reply.code(400).send(page("Não deu certo", "O link pode ter expirado. Peça um novo link ao Juca."));
    }
  });

  // --- Bancos (widget da Pluggy): as credenciais vão direto para a Pluggy ---
  const bankState = async (t: unknown) => {
    if (typeof t !== "string" || !/^[\w-]{20,}$/.test(t)) return null;
    const r = await query<{ user_id: number }>("SELECT user_id FROM oauth_states WHERE state = $1 AND provider = 'pluggy' AND expires_at > now()", [t]);
    return r.rows[0] ?? null;
  };

  app.get("/connect/bank", async (req, reply) => {
    const t = (req.query as { t?: string }).t;
    reply.type("text/html; charset=utf-8");
    const st = await bankState(t);
    if (!st) return reply.code(400).send(page("Link expirado", "Peça um novo link ao Juca."));
    const token = await createConnectToken(st.user_id);
    const data = JSON.stringify({ t, token, sandbox: config.PLUGGY_INCLUDE_SANDBOX === "true" }).replace(/</g, "\\u003c");
    return (
      page("Conectar banco", "O login é feito no ambiente seguro da Pluggy. O Juca só consulta saldos e extratos.") +
      `<script src="https://cdn.pluggy.ai/pluggy-connect/v2.8.2/pluggy-connect.js"></script><script>
       const d=${data};
       new PluggyConnect({connectToken:d.token,includeSandbox:d.sandbox,language:'pt',
         onSuccess:async({item})=>{await fetch('/connect/bank/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({t:d.t,itemId:item.id})});
           document.body.innerHTML='<h1 style="font-family:system-ui;text-align:center;margin-top:4rem">Banco conectado. Pode voltar pro chat.</h1>';}
       }).init();</script>`
    );
  });

  app.post("/connect/bank/complete", async (req, reply) => {
    const { t, itemId } = (req.body as { json: { t?: string; itemId?: string } }).json;
    const st = await bankState(t);
    if (!st || typeof itemId !== "string") return reply.code(400).send({ error: "invalid" });
    await query("DELETE FROM oauth_states WHERE state = $1", [t]);
    try {
      const bank = await linkItem(st.user_id, itemId);
      await notify(st.user_id, `Pronto! Conectei ${bank} ✅ Só consigo consultar: nunca movimento seu dinheiro.`);
      return { ok: true };
    } catch (e) {
      logger.error({ err: e }, "falha ao vincular banco");
      return reply.code(400).send({ error: "invalid_item" });
    }
  });

  app.register(adminRoutes, { prefix: "/admin" });
  return app;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, text: string) =>
  `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Juca</title>` +
  `<body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center"><h1>${escapeHtml(title)}</h1><p>${text}</p></body></html>`;
