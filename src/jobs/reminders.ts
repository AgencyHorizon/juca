import { runAgent } from "../agent/agent.js";
import { channels } from "../channels/index.js";
import { WindowClosedError, type ChannelName } from "../channels/types.js";
import { getUser } from "../core/users.js";
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

/** Rotina: o agente executa a instrução sem histórico. Ações consequentes ficam bloqueadas (ver ROUTINE_BLOCKED). */
async function runRoutine(userId: number, instruction: string): Promise<string> {
  const user = await getUser(userId);
  if (!user) throw new Error("usuário não encontrado");
  const r = await runAgent(user, [], `[Rotina agendada pela própria pessoa] ${instruction}`, { newSession: true, isRoutine: true });
  return `🔁 ${r.text}`;
}

/** Tenta o canal usado mais recentemente; se ele não puder iniciar conversa, tenta o próximo. */
async function deliver(targets: { channel: ChannelName; external_id: string; last_inbound_at: Date | null }[], text: string) {
  let lastErr: unknown;
  for (const t of targets) {
    const adapter = channels[t.channel];
    try {
      if (adapter.sendProactive) await adapter.sendProactive(t.external_id, text, { lastInboundAt: t.last_inbound_at ? new Date(t.last_inbound_at) : null });
      else await adapter.send(t.external_id, text);
      return;
    } catch (e) {
      lastErr = e;
      if (!(e instanceof WindowClosedError)) throw e;
    }
  }
  throw lastErr;
}

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
          "SELECT channel, external_id, last_inbound_at FROM channel_identities WHERE user_id = $1 ORDER BY last_inbound_at DESC NULLS LAST, id",
          [r.user_id],
        );
        if (!chan.rows.length) throw new Error("usuário sem canal");
        const lateMin = Math.round((Date.now() - new Date(r.due_at).getTime()) / 60_000);
        const late = lateMin > 15 ? `\n(desculpa o atraso de ${lateMin} min!)` : "";
        const text = r.is_routine ? await runRoutine(r.user_id, decrypt(r.text_enc)) : `⏰ Lembrete: ${decrypt(r.text_enc)}${late}`;
        await deliver(chan.rows, text);

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
