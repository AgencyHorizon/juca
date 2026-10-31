import { getAccessToken } from "./oauth.js";

/** Cliente mínimo da Gmail API (REST). Só o necessário para ler, buscar, rascunhar e enviar rascunhos. */
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_BODY = 4000;

async function gmail<T>(userId: number, path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken(userId);
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
  const html = find(part, "text/html") ?? "";
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

export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

/** Busca com a sintaxe do Gmail (ex.: "is:unread newer_than:2d", "from:banco"). */
export async function searchEmails(userId: number, q: string, max = 8): Promise<EmailSummary[]> {
  const list = await gmail<{ messages?: { id: string }[] }>(userId, `messages?${new URLSearchParams({ q, maxResults: String(Math.min(max, 15)) })}`);
  const ids = (list.messages ?? []).map((m) => m.id);
  const msgs = await Promise.all(
    ids.map((id) => gmail<GmailMessage>(userId, `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)),
  );
  return msgs.map((m) => ({
    id: m.id,
    from: header(m, "From"),
    subject: header(m, "Subject"),
    date: new Date(Number(m.internalDate)).toISOString(),
    snippet: m.snippet,
    unread: m.labelIds?.includes("UNREAD") ?? false,
  }));
}

export async function readEmail(userId: number, id: string) {
  const m = await gmail<GmailMessage>(userId, `messages/${encodeURIComponent(id)}?format=full`);
  const body = extractText(m.payload);
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m, "From"),
    to: header(m, "To"),
    subject: header(m, "Subject"),
    date: new Date(Number(m.internalDate)).toISOString(),
    messageId: header(m, "Message-ID"),
    body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) + "\n[…corpo truncado]" : body,
  };
}

/** Codifica um cabeçalho com acentos (RFC 2047). */
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

export function buildRawEmail(p: { to: string; subject: string; body: string; inReplyTo?: string }): string {
  const lines = [
    `To: ${p.to}`,
    `Subject: ${encodeHeader(p.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  if (p.inReplyTo) lines.push(`In-Reply-To: ${p.inReplyTo}`, `References: ${p.inReplyTo}`);
  const body = Buffer.from(p.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return Buffer.from(lines.join("\r\n") + "\r\n\r\n" + body).toString("base64url");
}

export async function createDraft(userId: number, p: { to: string; subject: string; body: string; replyToId?: string }) {
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  if (p.replyToId) {
    const orig = await readEmail(userId, p.replyToId);
    threadId = orig.threadId;
    inReplyTo = orig.messageId || undefined;
  }
  const raw = buildRawEmail({ to: p.to, subject: p.subject, body: p.body, inReplyTo });
  const d = await gmail<{ id: string }>(userId, "drafts", { method: "POST", body: JSON.stringify({ message: { raw, threadId } }) });
  return { draftId: d.id };
}

export async function sendDraft(userId: number, draftId: string) {
  return gmail<{ id: string }>(userId, "drafts/send", { method: "POST", body: JSON.stringify({ id: draftId }) });
}
