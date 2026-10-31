/** Mostra a última troca de mensagens de um usuário (dev). npx tsx --env-file=.env scripts/last-reply.ts <userId> [n] */
import { pool } from "../src/db/pool.js";
import { decrypt } from "../src/lib/crypto.js";
const [id, n = "2"] = process.argv.slice(2);
const r = await pool.query("SELECT role, content_enc, latency_ms FROM messages WHERE user_id=$1 ORDER BY id DESC LIMIT $2", [id, n]);
for (const m of r.rows.reverse()) console.log(`[${m.role}${m.latency_ms ? ` ${m.latency_ms}ms` : ""}] ${decrypt(m.content_enc)}\n`);
const rem = await pool.query("SELECT id, due_at, rrule, status FROM reminders WHERE user_id=$1 ORDER BY id DESC LIMIT 3", [id]);
console.log("lembretes:", rem.rows);
await pool.end();
