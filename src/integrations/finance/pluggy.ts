import { config } from "../../config.js";
import { audit } from "../../core/audit.js";
import { query } from "../../db/pool.js";

/**
 * Open Finance via Pluggy — SOMENTE LEITURA. O login no banco acontece no widget da Pluggy:
 * as credenciais nunca passam pelo Juca, pelo modelo ou pelo chat. O Juca guarda só o vínculo (item);
 * saldos e extratos são lidos na hora do pedido.
 */
const API = "https://api.pluggy.ai";
export const pluggyConfigured = () => !!(config.PLUGGY_CLIENT_ID && config.PLUGGY_CLIENT_SECRET);

let cached: { key: string; expires: number } | null = null;

async function apiKey(): Promise<string> {
  if (cached && cached.expires > Date.now()) return cached.key;
  const res = await fetch(`${API}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: config.PLUGGY_CLIENT_ID, clientSecret: config.PLUGGY_CLIENT_SECRET }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`pluggy auth ${res.status}`);
  const { apiKey: key } = (await res.json()) as { apiKey: string };
  cached = { key, expires: Date.now() + 110 * 60_000 }; // vale 2h
  return key;
}

async function pluggy<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "x-api-key": await apiKey(), "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`pluggy ${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export async function createConnectToken(userId: number): Promise<string> {
  const r = await pluggy<{ accessToken: string }>("/connect_token", { method: "POST", body: JSON.stringify({ options: { clientUserId: String(userId), avoidDuplicates: true } }) });
  return r.accessToken;
}

/** Só aceita um item criado para este usuário: impede vincular o banco de outra pessoa adulterando o itemId. */
export async function linkItem(userId: number, itemId: string): Promise<string> {
  const item = await pluggy<{ id: string; clientUserId?: string; connector?: { name?: string } }>(`/items/${encodeURIComponent(itemId)}`);
  if (item.clientUserId !== String(userId)) throw new Error("item não pertence a este usuário");
  const name = item.connector?.name ?? "banco";
  await query("INSERT INTO bank_items(user_id, item_id, connector_name) VALUES ($1,$2,$3) ON CONFLICT (user_id, item_id) DO UPDATE SET connector_name = EXCLUDED.connector_name", [userId, itemId, name]);
  await audit(userId, "user", "bank_connected");
  return name;
}

export async function listItems(userId: number): Promise<{ item_id: string; connector_name: string }[]> {
  const r = await query("SELECT item_id, connector_name FROM bank_items WHERE user_id = $1 ORDER BY id", [userId]);
  return r.rows;
}

interface Account {
  id: string;
  name: string;
  marketingName?: string;
  type: string;
  subtype?: string;
  balance: number;
  currencyCode: string;
  creditData?: { availableCreditLimit?: number; creditLimit?: number; balanceDueDate?: string };
}

export interface AccountView {
  id: string;
  bank: string;
  name: string;
  type: string;
  balance: number;
  currency: string;
  creditLimitAvailable?: number;
  dueDate?: string;
}

export async function accounts(userId: number): Promise<AccountView[]> {
  const out: AccountView[] = [];
  for (const it of await listItems(userId)) {
    const d = await pluggy<{ results: Account[] }>(`/accounts?itemId=${encodeURIComponent(it.item_id)}`);
    for (const a of d.results)
      out.push({
        id: a.id,
        bank: it.connector_name,
        name: a.marketingName ?? a.name,
        type: a.type === "CREDIT" ? "cartão de crédito" : "conta",
        balance: a.balance,
        currency: a.currencyCode,
        creditLimitAvailable: a.creditData?.availableCreditLimit,
        dueDate: a.creditData?.balanceDueDate,
      });
  }
  return out;
}

interface Tx {
  description: string;
  amount: number;
  date: string;
  type: string;
  category?: string;
  currencyCode: string;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Extrato por conta (paginação por cursor; lê no máximo 3 páginas). */
export async function transactions(accountId: string, days: number, max = 40) {
  const from = isoDate(new Date(Date.now() - days * 86_400_000));
  const base = `/v2/transactions`;
  let next: string | null = `?${new URLSearchParams({ accountId, dateFrom: from })}`;
  const all: Tx[] = [];
  for (let page = 0; page < 3 && next; page++) {
    const d: { results: Tx[]; next: string | null } = await pluggy(`${base}${next}`);
    all.push(...d.results);
    next = d.next;
  }
  all.sort((a, b) => b.date.localeCompare(a.date));
  const totalIn = all.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const totalOut = all.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  return {
    from,
    count: all.length,
    total_in: Number(totalIn.toFixed(2)),
    total_out: Number(totalOut.toFixed(2)),
    items: all.slice(0, max).map((t) => ({ date: t.date.slice(0, 10), description: t.description, amount: t.amount, category: t.category })),
  };
}

export async function ownsAccount(userId: number, accountId: string): Promise<boolean> {
  return (await accounts(userId)).some((a) => a.id === accountId);
}

/** Remove o vínculo na Pluggy (ela para de acessar o banco) e localmente. */
export async function disconnectBanks(userId: number): Promise<number> {
  const items = await listItems(userId);
  if (pluggyConfigured()) for (const it of items) await pluggy(`/items/${encodeURIComponent(it.item_id)}`, { method: "DELETE" }).catch(() => {});
  await query("DELETE FROM bank_items WHERE user_id = $1", [userId]);
  if (items.length) await audit(userId, "user", "bank_disconnected");
  return items.length;
}
