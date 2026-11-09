import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { safeEqual } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import { errors } from "../lib/metrics.js";
import { formatForChannel, splitMessage } from "./format.js";
import { WindowClosedError, type ChannelAdapter, type InboundMessage, type OutboundOptions } from "./types.js";

/**
 * Adapter da WhatsApp Cloud API (Meta). Tudo que é da sua conta vem do .env; veja docs/whatsapp.md
 * e valide as credenciais com `npm run whatsapp:check`.
 */
const graphUrl = (path: string) => `https://graph.facebook.com/${config.WHATSAPP_GRAPH_VERSION}/${path}`;

export const whatsappConfigured = () => !!(config.WHATSAPP_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID && config.WHATSAPP_APP_SECRET && config.WHATSAPP_VERIFY_TOKEN);

// Sem template aprovado, a Meta recusa mensagem livre 24h depois da última mensagem da pessoa (erro 131047).
const WINDOW_MS = 24 * 3600_000 - 10 * 60_000;

// RNF-10: valida X-Hub-Signature-256 (HMAC-SHA256 do corpo cru com o App Secret)
export function verifyWhatsApp(rawBody: Buffer, signature: unknown): boolean {
  if (!config.WHATSAPP_APP_SECRET || typeof signature !== "string") return false;
  const expected = "sha256=" + createHmac("sha256", config.WHATSAPP_APP_SECRET).update(rawBody).digest("hex");
  return safeEqual(expected, signature);
}

export function parseWhatsApp(body: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const names = new Map<string, string>((value?.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
      for (const m of value?.messages ?? []) {
        const msg: InboundMessage = {
          channel: "whatsapp",
          externalUserId: m.from,
          externalMessageId: m.id,
          phone: m.from, // no WhatsApp o wa_id é o número E.164 sem "+"
          displayName: names.get(m.from),
          receivedAt: new Date(Number(m.timestamp) * 1000).toISOString(),
        };
        if (m.type === "text") msg.text = m.text?.body;
        else if (m.type === "button") msg.text = m.button?.text;
        else if (m.type === "interactive") msg.text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
        else if (m.type === "audio") msg.audio = { fileId: m.audio.id, mimeType: m.audio.mime_type };
        else if (m.type === "reaction") msg.text = m.reaction?.emoji; // 👍/👎 como feedback (RF-29)
        if (msg.text || msg.audio) out.push(msg);
      }
    }
  }
  return out;
}

export interface WhatsAppStatus {
  id: string;
  status: string;
  recipient: string;
  errorCode?: number;
  errorTitle?: string;
}

/** A Meta informa entrega e falha por webhook: um envio aceito (HTTP 200) ainda pode falhar depois. */
export function parseWhatsAppStatuses(body: any): WhatsAppStatus[] {
  const out: WhatsAppStatus[] = [];
  for (const entry of body?.entry ?? [])
    for (const change of entry?.changes ?? [])
      for (const s of change?.value?.statuses ?? [])
        out.push({ id: s.id, status: s.status, recipient: s.recipient_id, errorCode: s.errors?.[0]?.code, errorTitle: s.errors?.[0]?.title });
  return out;
}

export function handleWhatsAppStatuses(body: any) {
  for (const s of parseWhatsAppStatuses(body)) {
    if (s.status !== "failed") continue;
    errors.inc({ where: `whatsapp_status:${s.errorCode ?? "unknown"}` });
    logger.error({ messageId: s.id, code: s.errorCode, title: s.errorTitle }, "WhatsApp não entregou a mensagem");
  }
}

async function graph(path: string, init?: RequestInit) {
  const res = await fetch(graphUrl(path), {
    ...init,
    headers: { authorization: `Bearer ${config.WHATSAPP_TOKEN}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`whatsapp ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

const postMessage = (payload: unknown) => graph(`${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, { method: "POST", body: JSON.stringify(payload) });

/** A Meta rejeita parâmetro de template com quebra de linha, tab ou 4+ espaços seguidos. */
export function templateParam(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 1000);
}

export function templatePayload(to: string, name: string, language: string, text: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: { name, language: { code: language }, components: [{ type: "body", parameters: [{ type: "text", text: templateParam(text) }] }] },
  };
}

export const whatsapp: ChannelAdapter = {
  name: "whatsapp",

  async send(to, text, opts?: OutboundOptions) {
    const parts = splitMessage(formatForChannel(text, "whatsapp"));
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      const quick = last ? opts?.quickReplies?.slice(0, 3) : undefined;
      await postMessage(
        quick?.length && part.length <= 1024
          ? {
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to,
              type: "interactive",
              interactive: { type: "button", body: { text: part }, action: { buttons: quick.map((t, idx) => ({ type: "reply", reply: { id: `qr_${idx}`, title: t.slice(0, 20) } })) } },
            }
          : { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: part, preview_url: false } },
      );
    }
  },

  /** Lembretes e rotinas: texto livre dentro da janela de 24h; fora dela, só template aprovado. */
  async sendProactive(to, text, ctx) {
    const inWindow = ctx.lastInboundAt && Date.now() - ctx.lastInboundAt.getTime() < WINDOW_MS;
    if (inWindow) return this.send(to, text);
    if (!config.WHATSAPP_REMINDER_TEMPLATE) throw new WindowClosedError();
    await postMessage(templatePayload(to, config.WHATSAPP_REMINDER_TEMPLATE, config.WHATSAPP_TEMPLATE_LANGUAGE, text));
  },

  /** Marca como lida e mostra "digitando…" enquanto o agente trabalha. */
  async ack(msg) {
    await postMessage({ messaging_product: "whatsapp", status: "read", message_id: msg.externalMessageId, typing_indicator: { type: "text" } });
  },

  async downloadAudio(mediaId) {
    const meta = (await (await graph(mediaId)).json()) as { url: string; mime_type: string };
    const res = await fetch(meta.url, { headers: { authorization: `Bearer ${config.WHATSAPP_TOKEN}` } });
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: meta.mime_type };
  },
};

export const whatsappInviteReady = () => whatsappConfigured() && !!config.WHATSAPP_INVITE_TEMPLATE;

/** Convite iniciado pelo Juca: o template tem {{1}} = quem convidou e {{2}} = código. */
export async function sendWhatsAppInvite(to: string, inviter: string, code: string) {
  await postMessage({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: config.WHATSAPP_INVITE_TEMPLATE,
      language: { code: config.WHATSAPP_TEMPLATE_LANGUAGE },
      components: [{ type: "body", parameters: [{ type: "text", text: templateParam(inviter) }, { type: "text", text: code }] }],
    },
  });
}

/** Usado pelo whatsapp:check para validar token e número. */
export async function whatsappPhoneInfo() {
  return (await (await graph(`${config.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`)).json()) as {
    display_phone_number: string;
    verified_name: string;
    quality_rating?: string;
  };
}
