import { config } from "../config.js";
import { purgeUser } from "../core/privacy.js";
import { query } from "../db/pool.js";
import { logger } from "../lib/logger.js";

/** RN-16 / RNF-16: retenção de logs de conversa + RN-15: garante exclusões pendentes em até 72h. */
export async function runRetention() {
  const msgs = await query("DELETE FROM messages WHERE created_at < now() - ($1 || ' days')::interval", [String(config.LOG_RETENTION_DAYS)]);
  await query("DELETE FROM processed_inbound WHERE received_at < now() - interval '7 days'");
  await query("DELETE FROM sessions s WHERE last_activity_at < now() - ($1 || ' days')::interval AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)", [String(config.LOG_RETENTION_DAYS)]);
  const pending = await query<{ id: string; user_id: string }>("SELECT id, user_id FROM deletion_requests WHERE completed_at IS NULL");
  for (const p of pending.rows) {
    await purgeUser(Number(p.user_id));
    await query("UPDATE deletion_requests SET completed_at = now() WHERE id = $1", [p.id]);
  }
  logger.info({ deletedMessages: msgs.rowCount, deletionRequests: pending.rowCount }, "retenção executada");
}
