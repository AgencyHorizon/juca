import { query } from "../db/pool.js";

// RNF-14: trilha imutável (trigger no banco bloqueia UPDATE/DELETE). Nunca grave PII aqui.
export async function audit(
  userId: number | null,
  actor: "user" | "agent" | "admin" | "system",
  action: string,
  details: Record<string, unknown> = {},
) {
  await query("INSERT INTO audit_log(user_id, actor, action, details) VALUES ($1,$2,$3,$4)", [userId, actor, action, details]);
}
