import { query } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { DomainError } from "./reminders.js";

// RF-20: fatos declarados pelo usuário, chave → valor (ex.: "aniversario" → "12/03").
export const normalizeKey = (k: string) =>
  k.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);

/**
 * RN-18: o MVP não armazena dados sensíveis. O modelo é instruído a não chamar a ferramenta
 * nesses casos; esta checagem é a segunda barreira (defesa em profundidade).
 */
const SENSITIVE = [
  /\b(cpf|rg|cnh|passaporte)\b/i,
  /\b(senha|password|pin|token)\b/i,
  /\b(cart[aã]o|cvv|conta banc|ag[eê]ncia|pix|sal[aá]rio|renda|d[ií]vida|investimento)/i,
  /\b(diagn[oó]stico|doen[cç]a|rem[eé]dio|medicamento|hiv|c[aâ]ncer|depress|ansiedade|gravidez|exame)/i,
  /\b(biometria|digital|impress[aã]o digital|face ?id)\b/i,
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/, // CPF
  /\b(?:\d[ -]?){13,19}\b/, // nº de cartão
];

export function looksSensitive(text: string): boolean {
  return SENSITIVE.some((re) => re.test(text));
}

export async function rememberFact(userId: number, key: string, value: string) {
  if (looksSensitive(`${key} ${value}`)) throw new DomainError("sensitive", "Dado sensível não é armazenado.");
  const k = normalizeKey(key);
  if (!k) throw new DomainError("invalid_key", "Chave inválida.");
  const { rows } = await query<{ n: string }>("SELECT count(*) n FROM memories WHERE user_id = $1", [userId]);
  if (Number(rows[0]!.n) >= 200) throw new DomainError("limit_reached", "Limite de memórias atingido.");
  await query(
    `INSERT INTO memories(user_id, key, value_enc) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`,
    [userId, k, encrypt(value.slice(0, 500))],
  );
  return { key: k, value };
}

export async function listFacts(userId: number): Promise<{ key: string; value: string }[]> {
  const r = await query("SELECT key, value_enc FROM memories WHERE user_id = $1 ORDER BY key", [userId]);
  return r.rows.map((x: any) => ({ key: x.key, value: decrypt(x.value_enc) }));
}

export async function forgetFact(userId: number, key: string) {
  const r = await query("DELETE FROM memories WHERE user_id = $1 AND key = $2", [userId, normalizeKey(key)]);
  if (!r.rowCount) throw new DomainError("not_found", "Não encontrei essa informação.");
}
