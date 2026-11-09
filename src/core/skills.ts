import { query } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { DomainError } from "./reminders.js";

/** Skills: procedimentos que a pessoa salva e chama com /nome. */
const MAX_SKILLS = 30;

export const normalizeSkillName = (n: string) =>
  n.trim().replace(/^\//, "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30);

const RESERVED = new Set(["start", "help", "ajuda"]);

export async function saveSkill(userId: number, name: string, instructions: string) {
  const n = normalizeSkillName(name);
  if (n.length < 2 || RESERVED.has(n)) throw new DomainError("invalid_name", "Escolha outro nome para a skill.");
  const { rows } = await query<{ n: number }>("SELECT count(*) n FROM skills WHERE user_id = $1", [userId]);
  if (Number(rows[0]!.n) >= MAX_SKILLS) throw new DomainError("limit_reached", "Limite de skills atingido.");
  await query(
    "INSERT INTO skills(user_id, name, instructions_enc) VALUES ($1,$2,$3) ON CONFLICT (user_id, name) DO UPDATE SET instructions_enc = EXCLUDED.instructions_enc",
    [userId, n, encrypt(instructions.slice(0, 2000))],
  );
  return n;
}

export async function listSkills(userId: number): Promise<{ name: string; instructions: string }[]> {
  const r = await query("SELECT name, instructions_enc FROM skills WHERE user_id = $1 ORDER BY name", [userId]);
  return r.rows.map((s: any) => ({ name: s.name, instructions: decrypt(s.instructions_enc) }));
}

export async function getSkill(userId: number, name: string): Promise<string | null> {
  const r = await query("SELECT instructions_enc FROM skills WHERE user_id = $1 AND name = $2", [userId, normalizeSkillName(name)]);
  return r.rows[0] ? decrypt(r.rows[0].instructions_enc) : null;
}

export async function deleteSkill(userId: number, name: string) {
  const r = await query("DELETE FROM skills WHERE user_id = $1 AND name = $2", [userId, normalizeSkillName(name)]);
  if (!r.rowCount) throw new DomainError("not_found", "Skill não encontrada.");
}

/** "/resumo hoje" vira o texto da skill + o que veio depois. Devolve null se não for uma skill. */
export async function expandSkill(userId: number, text: string): Promise<string | null> {
  const m = text.match(/^\/([a-zA-Z0-9_]{2,30})(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const instructions = await getSkill(userId, m[1]!);
  if (!instructions) return null;
  return `Execute a minha skill "${m[1]}": ${instructions}${m[2] ? `\nDetalhes deste pedido: ${m[2]}` : ""}`;
}
