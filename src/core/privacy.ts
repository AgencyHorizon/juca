import { query } from "../db/pool.js";
import { audit } from "./audit.js";
import { allLists, getList } from "./lists.js";
import { listFacts } from "./memories.js";
import { listReminders } from "./reminders.js";
import { formatLocal } from "./time.js";
import type { User } from "./users.js";
import { disconnectAll, listConnections } from "../integrations/oauth.js";
import { disconnectBanks, listItems } from "../integrations/finance/pluggy.js";

/** RF-27 / RNF-18: o que o Juca sabe sobre o usuário, em linguagem humana. */
export async function describeUserData(user: User): Promise<string> {
  const [facts, reminders, lists, msgs, email] = await Promise.all([
    listFacts(user.id),
    listReminders(user.id),
    allLists(user.id),
    query<{ n: string }>("SELECT count(*) n FROM messages WHERE user_id = $1", [user.id]),
    listConnections(user.id),
  ]);
  const banks = await listItems(user.id);
  const lines = [
    `Perfil: nome ${user.name ?? "(não informado)"}, fuso ${user.timezone}, telefone ${user.phone ? "verificado" : "não vinculado"}.`,
    `Contas conectadas: ${email.length ? email.map((c) => c.account_email).join(", ") : "nenhuma"} (não guardo seus e-mails, só leio quando você pede).`,
    `Bancos conectados: ${banks.length ? banks.map((b) => b.connector_name).join(", ") : "nenhum"} (só consulta; saldos e extratos não ficam guardados).`,
    `Fatos que você me contou: ${facts.length ? facts.map((f) => `${f.key} = ${f.value}`).join("; ") : "nenhum"}.`,
    `Lembretes ativos: ${reminders.length}.`,
    `Listas: ${lists.length ? lists.map((l) => `${l.name} (${l.pending} pendentes)`).join(", ") : "nenhuma"}.`,
    `Mensagens guardadas: ${msgs.rows[0]!.n} (apagadas automaticamente após 90 dias).`,
    `Uso dos dados para melhorar o modelo: ${user.training_consent ? "autorizado (anonimizado)" : "não autorizado"}.`,
  ];
  return lines.join("\n");
}

/** RN-19: portabilidade — exporta os dados em formato legível. */
export async function exportUserData(user: User): Promise<string> {
  const [facts, reminders, lists] = await Promise.all([listFacts(user.id), listReminders(user.id), allLists(user.id)]);
  const listDetails = await Promise.all(lists.map((l) => getList(user.id, l.name)));
  const out: string[] = ["📦 Seus dados no Juca", ""];
  out.push(`Nome: ${user.name ?? "-"}`, `Fuso horário: ${user.timezone}`, `Cliente desde: ${user.created_at.toISOString().slice(0, 10)}`, "");
  out.push("Fatos:", ...(facts.length ? facts.map((f) => `- ${f.key}: ${f.value}`) : ["- (nenhum)"]), "");
  out.push("Lembretes:", ...(reminders.length ? reminders.map((r) => `- ${r.text} — ${formatLocal(r.dueAt, user.timezone)}${r.rrule ? ` (${r.rrule})` : ""}`) : ["- (nenhum)"]), "");
  for (const l of listDetails) {
    if (!l) continue;
    out.push(`Lista "${l.name}":`, ...l.items.map((i) => `- ${i.done ? "[x]" : "[ ]"} ${i.text}`), "");
  }
  await audit(user.id, "user", "data_exported");
  return out.join("\n");
}

/**
 * RF-26 / RN-15: exclusão total. Executada imediatamente (SLA de 72h fica coberto também
 * pelo job de retenção, que reprocessa pedidos pendentes). O audit_log não contém PII.
 */
export async function deleteAllUserData(userId: number) {
  const req = await query<{ id: string }>("INSERT INTO deletion_requests(user_id) VALUES ($1) RETURNING id", [userId]);
  await audit(userId, "user", "data_deletion_requested");
  await purgeUser(userId);
  await query("UPDATE deletion_requests SET completed_at = now() WHERE id = $1", [req.rows[0]!.id]);
}

export async function purgeUser(userId: number) {
  // revoga o acesso ao Gmail no Google antes de apagar (não basta apagar o token localmente)
  await disconnectAll(userId).catch(() => {});
  await disconnectBanks(userId).catch(() => {});
  // ON DELETE CASCADE remove canais, sessões, mensagens, lembretes, listas, memórias e conexões
  await query("DELETE FROM users WHERE id = $1", [userId]);
  await audit(userId, "system", "data_deleted");
}
