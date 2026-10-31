import { query, tx } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { DomainError } from "./reminders.js";

export const normalizeListName = (name: string) =>
  name.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ") || "geral";

async function getOrCreateList(userId: number, name: string): Promise<number> {
  const n = normalizeListName(name);
  const r = await query<{ id: string }>(
    `INSERT INTO lists(user_id, name) VALUES ($1,$2)
     ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [userId, n],
  );
  return Number(r.rows[0]!.id);
}

async function findList(userId: number, name: string): Promise<number | null> {
  const r = await query<{ id: string }>("SELECT id FROM lists WHERE user_id = $1 AND name = $2", [userId, normalizeListName(name)]);
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

export async function addItems(userId: number, listName: string, items: string[]) {
  const clean = items.map((i) => i.trim()).filter(Boolean).slice(0, 100);
  if (!clean.length) throw new DomainError("empty", "Nenhum item informado.");
  const listId = await getOrCreateList(userId, listName);
  await tx(async (c) => {
    for (const item of clean) await c.query("INSERT INTO list_items(list_id, text_enc) VALUES ($1,$2)", [listId, encrypt(item)]);
  });
  return getList(userId, listName);
}

export async function getList(userId: number, listName: string) {
  const id = await findList(userId, listName);
  if (!id) return null;
  const r = await query("SELECT id, text_enc, done FROM list_items WHERE list_id = $1 ORDER BY id", [id]);
  return {
    name: normalizeListName(listName),
    items: r.rows.map((x: any, idx: number) => ({ n: idx + 1, id: Number(x.id), text: decrypt(x.text_enc), done: x.done })),
  };
}

export async function allLists(userId: number) {
  const r = await query(
    `SELECT l.name, count(i.id) FILTER (WHERE NOT i.done) AS pending
     FROM lists l LEFT JOIN list_items i ON i.list_id = l.id
     WHERE l.user_id = $1 GROUP BY l.id ORDER BY l.name`,
    [userId],
  );
  return r.rows.map((x: any) => ({ name: x.name as string, pending: Number(x.pending) }));
}

/** Remove (ou marca como feito) itens por número da posição exibida. */
export async function updateItems(userId: number, listName: string, numbers: number[], action: "remove" | "done") {
  const list = await getList(userId, listName);
  if (!list) throw new DomainError("not_found", "Lista não encontrada.");
  const ids = list.items.filter((i) => numbers.includes(i.n)).map((i) => i.id);
  if (!ids.length) throw new DomainError("not_found", "Itens não encontrados.");
  if (action === "remove") await query("DELETE FROM list_items WHERE id = ANY($1)", [ids]);
  else await query("UPDATE list_items SET done = TRUE WHERE id = ANY($1)", [ids]);
  return getList(userId, listName);
}

export async function clearList(userId: number, listName: string) {
  const id = await findList(userId, listName);
  if (!id) throw new DomainError("not_found", "Lista não encontrada.");
  await query("DELETE FROM lists WHERE id = $1 AND user_id = $2", [id, userId]);
}
