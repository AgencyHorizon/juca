import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { audit } from "../core/audit.js";
import { channels } from "../channels/index.js";
import { createInvite, inviteLink } from "../core/invites.js";
import { channelsOf } from "../core/users.js";
import { FLAG_DEFAULTS, setFlag } from "../core/flags.js";
import { query } from "../db/pool.js";
import { safeEqual } from "../lib/crypto.js";

/**
 * Backoffice (RF-30..RF-33). API JSON protegida por token; um painel (Grafana/Metabase
 * ou uma página interna) consome estes endpoints. Nada aqui expõe conteúdo de mensagens
 * sem consentimento (RF-32): os logs de conversa só são listados para quem autorizou.
 */
export async function adminRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!config.ADMIN_TOKEN || !safeEqual(token, config.ADMIN_TOKEN)) return reply.code(401).send({ error: "unauthorized" });
  });

  // RF-30: métricas de uso, retenção, qualidade e custo
  app.get("/metrics/summary", async () => {
    const [users, dau, wau, activation, retention, feedback, tokens, latency] = await Promise.all([
      query(`SELECT status, count(*)::int n FROM users GROUP BY status`),
      query(`SELECT count(DISTINCT user_id)::int n FROM messages WHERE role='user' AND created_at > now() - interval '1 day'`),
      query(`SELECT count(DISTINCT user_id)::int n FROM messages WHERE role='user' AND created_at > now() - interval '7 days'`),
      // ativação: usuários que concluíram ≥1 tarefa (tool call auditada) no 1º dia
      query(`SELECT round(100.0 * count(*) FILTER (WHERE first_task IS NOT NULL AND first_task < u.created_at + interval '1 day') / NULLIF(count(*),0), 1) pct
               FROM users u LEFT JOIN LATERAL (
                 SELECT min(created_at) first_task FROM audit_log a WHERE a.user_id = u.id AND a.actor='agent') t ON true
              WHERE u.created_at < now() - interval '1 day'`),
      query(`SELECT
               round(100.0 * count(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages m WHERE m.user_id=u.id AND m.role='user' AND m.created_at >= u.created_at + interval '7 days')) / NULLIF(count(*) FILTER (WHERE u.created_at < now() - interval '7 days'),0),1) d7,
               round(100.0 * count(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages m WHERE m.user_id=u.id AND m.role='user' AND m.created_at >= u.created_at + interval '30 days')) / NULLIF(count(*) FILTER (WHERE u.created_at < now() - interval '30 days'),0),1) d30
             FROM users u`),
      query(`SELECT prompt_version, count(*) FILTER (WHERE rating=1)::int up, count(*) FILTER (WHERE rating=-1)::int down
               FROM messages WHERE role='assistant' AND created_at > now() - interval '30 days' GROUP BY prompt_version`),
      query(`SELECT model, sum(input_tokens)::bigint input, sum(output_tokens)::bigint output, count(DISTINCT user_id)::int users
               FROM messages WHERE role='assistant' AND created_at > date_trunc('month', now()) GROUP BY model`),
      query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) p95
               FROM messages WHERE role='assistant' AND created_at > now() - interval '1 day'`),
    ]);
    return {
      users: users.rows,
      dau: dau.rows[0].n,
      wau: wau.rows[0].n,
      activationPct: activation.rows[0].pct,
      retention: retention.rows[0],
      feedbackByPrompt: feedback.rows,
      tokensThisMonth: tokens.rows,
      latencyMs24h: latency.rows[0],
    };
  });

  // RF-31: gestão de usuários (sem conteúdo de mensagens)
  app.get("/users", async (req) => {
    const { q, status } = req.query as { q?: string; status?: string };
    const r = await query(
      `SELECT id, name, phone, status, cohort, abuse_strikes, created_at, last_seen_at FROM users
        WHERE ($1::text IS NULL OR phone LIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR status = $2)
        ORDER BY id DESC LIMIT 100`,
      [q ?? null, status ?? null],
    );
    return r.rows;
  });

  app.post("/users/:id/block", async (req) => {
    const id = Number((req.params as any).id);
    const { reason } = (req.body ?? {}) as { reason?: string };
    await query("UPDATE users SET status='blocked' WHERE id=$1", [id]);
    await audit(id, "admin", "user_blocked", { reason: reason ?? null });
    return { ok: true };
  });

  // Convites e lista de espera
  app.post("/invites", async (req) => {
    const count = Math.min(Number((req.body as any)?.json?.count ?? 1), 100);
    const codes: string[] = [];
    for (let i = 0; i < count; i++) codes.push(await createInvite(null));
    await audit(null, "admin", "invites_created", { count });
    return codes.map((code) => ({ code, link: inviteLink(code) }));
  });

  app.get("/invites", async () => (await query("SELECT code, created_by, used_by, created_at, used_at FROM invites ORDER BY created_at DESC LIMIT 200")).rows);

  app.get("/waitlist", async () => (await query("SELECT id, name, created_at FROM users WHERE status='onboarding' AND onboarding_step='waitlist' ORDER BY id")).rows);

  app.post("/users/:id/approve", async (req, reply) => {
    const id = Number((req.params as any).id);
    const r = await query("UPDATE users SET invite_accepted = TRUE, onboarding_step = 'start' WHERE id=$1 AND onboarding_step='waitlist' RETURNING id", [id]);
    if (!r.rowCount) return reply.code(404).send({ error: "not_on_waitlist" });
    await audit(id, "admin", "waitlist_approved");
    const chan = (await channelsOf(id))[0];
    if (chan) await channels[chan.channel].send(chan.external_id, "Sua vaga no Juca abriu! 🎉 Manda um oi pra gente começar.").catch(() => {});
    return { ok: true };
  });

  app.post("/users/:id/unblock", async (req) => {
    const id = Number((req.params as any).id);
    await query("UPDATE users SET status='active', abuse_strikes=0 WHERE id=$1 AND status='blocked'", [id]);
    await audit(id, "admin", "user_unblocked");
    return { ok: true };
  });

  app.post("/users/:id/cohort", async (req) => {
    const id = Number((req.params as any).id);
    const { cohort } = req.body as { cohort: string };
    await query("UPDATE users SET cohort=$2 WHERE id=$1", [id, cohort]);
    await audit(id, "admin", "cohort_changed", { cohort });
    return { ok: true };
  });

  // RF-32: logs de conversa — só de quem consentiu (RN-17); acesso auditado
  app.get("/users/:id/conversation", async (req, reply) => {
    const id = Number((req.params as any).id);
    const u = await query("SELECT training_consent FROM users WHERE id=$1", [id]);
    if (!u.rows[0]) return reply.code(404).send({ error: "not_found" });
    if (!u.rows[0].training_consent) return reply.code(403).send({ error: "no_consent" });
    const { decrypt } = await import("../lib/crypto.js");
    const r = await query("SELECT id, role, content_enc, rating, created_at FROM messages WHERE user_id=$1 ORDER BY id DESC LIMIT 200", [id]);
    await audit(id, "admin", "conversation_viewed");
    return r.rows.map((m: any) => ({ id: m.id, role: m.role, text: decrypt(m.content_enc), rating: m.rating, at: m.created_at }));
  });

  app.get("/audit", async (req) => {
    const { userId } = req.query as { userId?: string };
    const r = await query("SELECT * FROM audit_log WHERE ($1::bigint IS NULL OR user_id=$1) ORDER BY id DESC LIMIT 500", [userId ?? null]);
    return r.rows;
  });

  // RF-33: feature flags
  app.get("/flags", async () => {
    const r = await query("SELECT key, scope, enabled, updated_at FROM feature_flags ORDER BY key, scope");
    return { defaults: FLAG_DEFAULTS, overrides: r.rows };
  });

  app.put("/flags/:key", async (req) => {
    const key = (req.params as any).key as string;
    const { scope = "global", enabled } = req.body as { scope?: string; enabled: boolean };
    await setFlag(key, scope, enabled);
    await audit(null, "admin", "flag_changed", { key, scope, enabled });
    return { ok: true };
  });
}
