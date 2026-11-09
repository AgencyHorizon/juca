/**
 * Teste real da Pluggy no sandbox: conecta o banco de testes como o widget faria, lê saldo e extrato
 * pelo código do Juca e remove tudo no final.
 *   npx tsx --env-file=.env scripts/pluggy-smoke.ts
 * Autenticação: PLUGGY_CLIENT_ID + PLUGGY_CLIENT_SECRET, ou PLUGGY_TEMP_API_KEY.
 */
import { accounts, createConnectToken, disconnectBanks, linkItem, listItems, transactions } from "../src/integrations/finance/pluggy.js";
import { findOrCreateByChannel } from "../src/core/users.js";
import { pool } from "../src/db/pool.js";

const API = "https://api.pluggy.ai";
const { user } = await findOrCreateByChannel("telegram", `pluggy-smoke-${Date.now()}`);

try {
  const connectToken = await createConnectToken(user.id);
  console.log("1. connect token: ok");

  const headers = { "x-api-key": connectToken, "content-type": "application/json" };
  const list = (await (await fetch(`${API}/connectors?sandbox=true`, { headers })).json()) as { results: { id: number; name: string; isSandbox?: boolean }[] };
  const sandbox = list.results.find((c) => c.isSandbox && /pluggy bank/i.test(c.name)) ?? list.results.find((c) => c.isSandbox);
  if (!sandbox) throw new Error("nenhum conector sandbox disponível nesta conta");
  console.log(`2. conector sandbox: ${sandbox.name} (${sandbox.id})`);

  const res = await fetch(`${API}/items`, { method: "POST", headers, body: JSON.stringify({ connectorId: sandbox.id, parameters: { user: "user-ok", password: "password-ok" } }) });
  const created = (await res.json()) as { id?: string; message?: string };
  if (!created.id) throw new Error(`criação do item: HTTP ${res.status} ${JSON.stringify(created).slice(0, 300)}`);
  console.log("3. item criado");

  let status = "";
  for (let i = 0; i < 40 && !["UPDATED", "LOGIN_ERROR", "OUTDATED"].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const it = (await (await fetch(`${API}/items/${created.id}`, { headers })).json()) as { status: string };
    status = it.status;
  }
  console.log(`4. status do item: ${status}`);

  console.log(`5. vínculo: ${await linkItem(user.id, created.id)}`);
  try {
    await linkItem(user.id + 999_999, created.id);
    console.log("6. FALHA: aceitou item de outro usuário");
  } catch (e) {
    console.log(`6. item de outro usuário recusado: ${(e as Error).message}`);
  }

  const acc = await accounts(user.id);
  console.log(`7. contas: ${JSON.stringify(acc.map((a) => ({ bank: a.bank, name: a.name, type: a.type, balance: a.balance, currency: a.currency, limit: a.creditLimitAvailable })))}`);

  const first = acc[0];
  if (first) {
    const tx = await transactions(first.id, 90, 3);
    console.log(`8. extrato 90 dias: ${tx.count} lançamentos, entradas ${tx.total_in}, saídas ${tx.total_out}`);
    console.log(`   amostra: ${JSON.stringify(tx.items)}`);
  }
} finally {
  const removed = await disconnectBanks(user.id).catch((e) => `erro: ${e.message}`);
  console.log(`9. limpeza: itens removidos = ${removed}; restantes = ${(await listItems(user.id)).length}`);
  await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
  await pool.end();
}
process.exit(0);
