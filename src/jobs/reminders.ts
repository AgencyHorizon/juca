import { channels } from "../channels/index.js";
import { audit } from "../core/audit.js";
import { nextOccurrence } from "../core/time.js";
import { pool } from "../db/pool.js";
import { decrypt } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import { remindersSent } from "../lib/metrics.js";

/**
 * RF-25 / RNF-23: disparo proativo de lembretes.
 * Usa o Postgres como fonte da verdade (não depende de jobs atrasados em memória/Redis):
 * cada ciclo pega lembretes vencidos com FOR UPDATE SKIP LOCKED, então vários workers
 * podem rodar em paralelo sem enviar em dobro. Falhas têm retry com backoff exponencial.
 */
const BATCH = 100;
const MAX_ATTEMPTS = 8;

export async function dispatchDueReminders(): Promise<number> {
  const client = await pool.connect();
  let sent = 0;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT r.*, u.timezone, u.name, u.status AS user_status
         FROM reminders r JOIN users u ON u.id = r.user_id
        WHERE r.status = 'active' AND r.due_at <= now()
          AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= now())
        ORDER BY r.due_at
        LIMIT $1
        FOR UPDATE OF r SKIP LOCKED`,
      [BATCH],
    );
    for (const r of rows) {
      try {
        if (r.user_status === "blocked") {
          await client.query("UPDATE reminders SET status = 'cancelled' WHERE id = $1", [r.id]);
          continue;
        }
        const chan = await client.query(
          "SELECT channel, external_id FROM channel_identities WHERE user_id = $1 ORDER BY id LIMIT 1",
          [r.user_id],
        );
        const target = chan.rows[0];
        if (!target) throw new Error("usuário sem canal");
        const lateMin = Math.round((Date.now() - new Date(r.due_at).getTime()) / 60_000);
        const text = `⏰ Lembrete: ${decrypt(r.text_enc)}${lateMin > 15 ? `\n(desculpa o atraso de ${lateMin} min!)` : ""}`;
        await channels[target.channel as "whatsapp" | "telegram"].send(target.external_id, text);

        const next = r.rrule ? nextOccurrence(r.rrule, new Date(r.due_at), r.timezone) : null;
        if (next) {
          await client.query("UPDATE reminders SET due_at = $2, attempts = 0, next_attempt_at = NULL, updated_at = now() WHERE id = $1", [r.id, next]);
        } else {
          await client.query("UPDATE reminders SET status = 'sent', updated_at = now() WHERE id = $1", [r.id]);
        }
        remindersSent.inc({ outcome: "sent" });
        sent++;
      } catch (e) {
        const attempts = r.attempts + 1;
        const giveUp = attempts >= MAX_ATTEMPTS;
        const delaySec = Math.min(2 ** attempts * 15, 3600);
        await client.query(
          `UPDATE reminders SET attempts = $2, last_error = $3, next_attempt_at = now() + ($4 || ' seconds')::interval,
             status = CASE WHEN $5 THEN 'cancelled' ELSE status END, updated_at = now() WHERE id = $1`,
          [r.id, attempts, String((e as Error).message).slice(0, 500), String(delaySec), giveUp],
        );
        remindersSent.inc({ outcome: giveUp ? "failed" : "retry" });
        logger.error({ err: e, reminderId: r.id, attempts }, "falha ao enviar lembrete");
        if (giveUp) await audit(r.user_id, "system", "reminder_delivery_failed", { reminder_id: r.id });
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return sent;
}
