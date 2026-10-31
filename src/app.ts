import Fastify from "fastify";
import { config } from "./config.js";
import { adminRoutes } from "./admin/routes.js";
import { parseTelegram, verifyTelegram } from "./channels/telegram.js";
import { parseWhatsApp, verifyWhatsApp } from "./channels/whatsapp.js";
import { pool } from "./db/pool.js";
import { enqueueInbound } from "./jobs/queue.js";
import { safeEqual } from "./lib/crypto.js";
import { logger } from "./lib/logger.js";
import { registry } from "./lib/metrics.js";
import { redis } from "./lib/redis.js";
import { channels } from "./channels/index.js";
import { channelsOf } from "./core/users.js";
import { handleCallback } from "./integrations/google/oauth.js";

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
    return reply.code(200).send();
  });

  // --- OAuth do Google (conexão do e-mail) ---
  app.get("/oauth/google/callback", async (req, reply) => {
    const q = req.query as { state?: string; code?: string; error?: string };
    reply.type("text/html; charset=utf-8");
    if (q.error || !q.state || !q.code) {
      return reply.code(400).send(page("Conexão cancelada", "Nada foi conectado. Se quiser tentar de novo, peça um novo link ao Juca."));
    }
    try {
      const { userId, email } = await handleCallback(q.state, q.code);
      const chan = (await channelsOf(userId))[0];
      if (chan)
        await channels[chan.channel]
          .send(chan.external_id, `Pronto! Conectei o e-mail ${email} ✅ Agora posso ler, buscar e resumir seus e-mails e preparar rascunhos. Quer que eu veja o que chegou de novo?`)
          .catch((e) => logger.error({ err: e }, "falha ao avisar conexão"));
      return page("E-mail conectado ✅", `O Juca agora tem acesso a ${escapeHtml(email)}. Pode voltar pro chat.`);
    } catch (e) {
      logger.error({ err: e }, "falha no callback do OAuth");
      return reply.code(400).send(page("Não deu certo", "O link pode ter expirado. Peça um novo link ao Juca."));
    }
  });

  app.register(adminRoutes, { prefix: "/admin" });
  return app;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, text: string) =>
  `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Juca</title>` +
  `<body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center"><h1>${escapeHtml(title)}</h1><p>${text}</p></body></html>`;
