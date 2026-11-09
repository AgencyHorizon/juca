import { getAccessToken } from "../oauth.js";
import { MAX_BODY, type Draft, type DraftInput, type MailClient, type MailFull, type MailSearch, type MailSummary } from "./types.js";

/** Cliente mínimo da Gmail API (REST). */
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gmail<T>(userId: number, path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken(userId, "google");
  const res = await fetch(`${API}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`gmail ${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

interface Part {
  mimeType: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  labelIds?: string[];
  internalDate: string;
  payload: Part & { headers: { name: string; value: string }[] };
}

const header = (m: GmailMessage, name: string) => m.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** Extrai texto legível do e-mail (prefere text/plain; cai para HTML sem tags). */
export function extractText(part: Part): string {
  const decode = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");
  const find = (p: Part, type: string): string | null => {
    if (p.mimeType === type && p.body?.data) return decode(p.body.data);
    for (const c of p.parts ?? []) {
      const r = find(c, type);
      if (r) return r;
    }
    return null;
  };
  const plain = find(part, "text/plain");
  if (plain) return plain.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return htmlToText(find(part, "text/html") ?? "");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildGmailQuery(q: MailSearch): string {
  const parts: string[] = [];
  if (q.text) parts.push(q.text);
  if (q.from) parts.push(`from:${q.from}`);
  if (q.unreadOnly) parts.push("is:unread");
  if (q.newerThanDays) parts.push(`newer_than:${q.newerThanDays}d`);
  return parts.join(" ") || "in:inbox";
}

/** Codifica um cabeçalho com acentos (RFC 2047). */
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

export function buildRawEmail(p: { to: string; subject: string; body: string; inReplyTo?: string }): string {
  const lines = [`To: ${p.to}`, `Subject: ${encodeHeader(p.subject)}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"];
  if (p.inReplyTo) lines.push(`In-Reply-To: ${p.inReplyTo}`, `References: ${p.inReplyTo}`);
  const body = Buffer.from(p.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return Buffer.from(lines.join("\r\n") + "\r\n\r\n" + body).toString("base64url");
}

function decodeSubject(s: string): string {
  return s.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_m, b: string) => Buffer.from(b, "base64").toString("utf8"));
}

async function full(userId: number, id: string): Promise<MailFull & { threadId: string; messageId: string }> {
  const m = await gmail<GmailMessage>(userId, `messages/${encodeURIComponent(id)}?format=full`);
  const body = extractText(m.payload);
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m, "From"),
    to: header(m, "To"),
    subject: header(m, "Subject"),
    date: new Date(Number(m.internalDate)).toISOString(),
    snippet: m.snippet,
    unread: m.labelIds?.includes("UNREAD") ?? false,
    messageId: header(m, "Message-ID"),
    body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) + "\n[…corpo truncado]" : body,
  };
}

export const gmailClient: MailClient = {
  async search(userId, q): Promise<MailSummary[]> {
    const list = await gmail<{ messages?: { id: string }[] }>(userId, `messages?${new URLSearchParams({ q: buildGmailQuery(q), maxResults: String(Math.min(q.max ?? 8, 15)) })}`);
    const msgs = await Promise.all(
      (list.messages ?? []).map((m) => gmail<GmailMessage>(userId, `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)),
    );
    return msgs.map((m) => ({
      id: m.id,
      from: header(m, "From"),
      subject: header(m, "Subject"),
      date: new Date(Number(m.internalDate)).toISOString(),
      snippet: m.snippet,
      unread: m.labelIds?.includes("UNREAD") ?? false,
    }));
  },

  async read(userId, id) {
    const { threadId: _t, messageId: _m, ...mail } = await full(userId, id);
    return mail;
  },

  async createDraft(userId, p: DraftInput) {
    let threadId: string | undefined;
    let inReplyTo: string | undefined;
    if (p.replyToId) {
      const orig = await full(userId, p.replyToId);
      threadId = orig.threadId;
      inReplyTo = orig.messageId || undefined;
    }
    const raw = buildRawEmail({ to: p.to, subject: p.subject, body: p.body, inReplyTo });
    const d = await gmail<{ id: string }>(userId, "drafts", { method: "POST", body: JSON.stringify({ message: { raw, threadId } }) });
    return { draftId: d.id };
  },

  async getDraft(userId, draftId): Promise<Draft> {
    const d = await gmail<{ id: string; message: GmailMessage }>(userId, `drafts/${encodeURIComponent(draftId)}?format=full`);
    return { id: d.id, to: header(d.message, "To"), subject: decodeSubject(header(d.message, "Subject")), body: extractText(d.message.payload) };
  },

  async sendDraft(userId, draftId) {
    await gmail(userId, "drafts/send", { method: "POST", body: JSON.stringify({ id: draftId }) });
  },
};
