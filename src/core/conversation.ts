import { config } from "../config.js";
import { query } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";

/** RN-14: nova sessão após SESSION_TIMEOUT_HOURS de inatividade. */
export async function currentSession(userId: number): Promise<{ id: number; isNew: boolean }> {
  const r = await query<{ id: string; last_activity_at: Date }>(
    "SELECT id, last_activity_at FROM sessions WHERE user_id = $1 ORDER BY last_activity_at DESC LIMIT 1",
    [userId],
  );
  const s = r.rows[0];
  if (s && Date.now() - new Date(s.last_activity_at).getTime() < config.SESSION_TIMEOUT_HOURS * 3600_000) {
    await query("UPDATE sessions SET last_activity_at = now() WHERE id = $1", [s.id]);
    return { id: Number(s.id), isNew: false };
  }
  const n = await query<{ id: string }>("INSERT INTO sessions(user_id) VALUES ($1) RETURNING id", [userId]);
  return { id: Number(n.rows[0]!.id), isNew: true };
}

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
}

/** RF-19: histórico de curto prazo. Limitado em quantidade para controlar custo (RNF-32). */
export async function recentHistory(sessionId: number, limit = 20): Promise<StoredMessage[]> {
  const r = await query(
    "SELECT role, content_enc FROM (SELECT * FROM messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2) t ORDER BY id",
    [sessionId, limit],
  );
  return r.rows.map((m: any) => ({ role: m.role, text: decrypt(m.content_enc) }));
}

export async function saveMessage(m: {
  userId: number;
  sessionId: number | null;
  role: "user" | "assistant";
  channel: string;
  text: string;
  promptVersion?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}): Promise<number> {
  const r = await query<{ id: string }>(
    `INSERT INTO messages(user_id, session_id, role, channel, content_enc, prompt_version, model, input_tokens, output_tokens, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [m.userId, m.sessionId, m.role, m.channel, encrypt(m.text), m.promptVersion ?? null, m.model ?? null, m.inputTokens ?? null, m.outputTokens ?? null, m.latencyMs ?? null],
  );
  return Number(r.rows[0]!.id);
}

/** RF-29: 👍/👎 avalia a última resposta do Juca. */
export async function rateLastReply(userId: number, rating: 1 | -1): Promise<boolean> {
  const r = await query(
    `UPDATE messages SET rating = $2 WHERE id = (
       SELECT id FROM messages WHERE user_id = $1 AND role = 'assistant' ORDER BY id DESC LIMIT 1)`,
    [userId, rating],
  );
  return (r.rowCount ?? 0) > 0;
}

/** RNF-24: retorna false se a mensagem já foi processada. */
export async function markProcessed(channel: string, externalMessageId: string): Promise<boolean> {
  const r = await query(
    "INSERT INTO processed_inbound(channel, external_message_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [channel, externalMessageId],
  );
  return (r.rowCount ?? 0) > 0;
}
