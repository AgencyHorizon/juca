import { getAccessToken } from "../oauth.js";
import { htmlToText } from "./gmail.js";
import { MAX_BODY, type Draft, type MailClient, type MailFull, type MailSearch, type MailSummary } from "./types.js";

/** Outlook / Microsoft 365 via Microsoft Graph. */
const API = "https://graph.microsoft.com/v1.0/me";
const SELECT = "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead";

async function graph(userId: number, path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken(userId, "microsoft");
  const res = await fetch(`${API}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", prefer: 'outlook.body-content-type="text"' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`graph ${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

interface GraphMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  body?: { contentType?: string; content?: string };
}

const fromStr = (m: GraphMessage) => {
  const e = m.from?.emailAddress;
  return e?.name ? `${e.name} <${e.address}>` : (e?.address ?? "");
};
const summary = (m: GraphMessage): MailSummary => ({
  id: m.id,
  from: fromStr(m),
  subject: m.subject ?? "",
  date: m.receivedDateTime ?? "",
  snippet: m.bodyPreview ?? "",
  unread: m.isRead === false,
});
const bodyText = (m: GraphMessage) => (m.body?.contentType?.toLowerCase() === "html" ? htmlToText(m.body.content ?? "") : (m.body?.content ?? "").trim());

/**
 * $search não combina de forma confiável com $filter em mensagens: com texto usamos $search e
 * filtramos não lidas/data aqui; sem texto usamos $filter e ordenação.
 */
export function buildOutlookQuery(q: MailSearch, now = new Date()): { qs: URLSearchParams; since: Date | null } {
  const top = String(Math.min(q.max ?? 8, 15));
  const since = q.newerThanDays ? new Date(now.getTime() - q.newerThanDays * 86_400_000) : null;
  const qs = new URLSearchParams({ $select: SELECT, $top: top });
  if (q.text || q.from) {
    const clauses: string[] = [];
    if (q.text) clauses.push(q.text.replace(/"/g, ""));
    if (q.from) clauses.push(`from:${q.from.replace(/"/g, "")}`);
    qs.set("$search", `"${clauses.join(" AND ")}"`);
    qs.set("$top", "25");
  } else {
    const filters: string[] = [];
    if (q.unreadOnly) filters.push("isRead eq false");
    if (since) filters.push(`receivedDateTime ge ${since.toISOString()}`);
    if (filters.length) qs.set("$filter", filters.join(" and "));
    qs.set("$orderby", "receivedDateTime desc");
  }
  return { qs, since };
}

export const outlookClient: MailClient = {
  async search(userId, q) {
    const { qs, since } = buildOutlookQuery(q);
    const data = (await (await graph(userId, `messages?${qs}`)).json()) as { value: GraphMessage[] };
    return data.value
      .filter((m) => (q.text || q.from ? (!q.unreadOnly || m.isRead === false) && (!since || new Date(m.receivedDateTime ?? 0) >= since) : true))
      .slice(0, Math.min(q.max ?? 8, 15))
      .map(summary);
  },

  async read(userId, id): Promise<MailFull> {
    const m = (await (await graph(userId, `messages/${encodeURIComponent(id)}?$select=${SELECT},body`)).json()) as GraphMessage;
    const body = bodyText(m);
    return {
      ...summary(m),
      to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address).join(", "),
      body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) + "\n[…corpo truncado]" : body,
    };
  },

  async createDraft(userId, p) {
    const content = { subject: p.subject, body: { contentType: "Text", content: p.body }, toRecipients: [{ emailAddress: { address: p.to } }] };
    if (p.replyToId) {
      const d = (await (await graph(userId, `messages/${encodeURIComponent(p.replyToId)}/createReply`, { method: "POST" })).json()) as GraphMessage;
      await graph(userId, `messages/${encodeURIComponent(d.id)}`, { method: "PATCH", body: JSON.stringify(content) });
      return { draftId: d.id };
    }
    const d = (await (await graph(userId, "messages", { method: "POST", body: JSON.stringify(content) })).json()) as GraphMessage;
    return { draftId: d.id };
  },

  async getDraft(userId, draftId): Promise<Draft> {
    const m = (await (await graph(userId, `messages/${encodeURIComponent(draftId)}?$select=${SELECT},body`)).json()) as GraphMessage;
    return { id: m.id, to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address).join(", "), subject: m.subject ?? "", body: bodyText(m) };
  },

  async sendDraft(userId, draftId) {
    await graph(userId, `messages/${encodeURIComponent(draftId)}/send`, { method: "POST" });
  },
};
