/**
 * Conversa de teste com o agente real (LLM + ferramentas + banco), sem passar pelos canais.
 *   npx tsx --env-file=.env scripts/agent-smoke.ts "me lembra de beber água às 15h"
 */
import { runAgent } from "../src/agent/agent.js";
import { findOrCreateByChannel, updateUser } from "../src/core/users.js";
import { pool } from "../src/db/pool.js";
import { redis } from "../src/lib/redis.js";

const { user } = await findOrCreateByChannel("telegram", "smoke-test-user");
const u = await updateUser(user.id, { status: "active", name: "Teste", timezone: "America/Recife", onboarding_step: "done" });
for (const text of process.argv.slice(2)) {
  const t0 = Date.now();
  const r = await runAgent(u, [], text, { newSession: false });
  console.log(`\n> ${text}\n[${r.model} · ${Date.now() - t0}ms]\n${r.text}`);
}
await pool.query("DELETE FROM users WHERE id = $1", [u.id]);
await pool.end();
redis.disconnect();
