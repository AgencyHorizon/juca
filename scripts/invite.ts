/** Gera convites de administrador: npm run invite -- 5 */
import { createInvite, inviteLink } from "../src/core/invites.js";
import { pool } from "../src/db/pool.js";

const count = Math.min(Number(process.argv[2] ?? 1), 100);
for (let i = 0; i < count; i++) {
  const code = await createInvite(null);
  console.log(`${code}  ${inviteLink(code) ?? ""}`);
}
await pool.end();
