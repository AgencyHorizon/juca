import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { safeEqual } from "../lib/crypto.js";
import { formatForChannel, splitMessage } from "./format.js";
import type { ChannelAdapter, InboundMessage, OutboundOptions } from "./types.js";

const GRAPH = "https://graph.facebook.com/v23.0";

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
        else if (m.type === "interactive")
          msg.text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
        else if (m.type === "audio") msg.audio = { fileId: m.audio.id, mimeType: m.audio.mime_type };
        else if (m.type === "reaction") msg.text = m.reaction?.emoji; // 👍/👎 como feedback (RF-29)
        if (msg.text || msg.audio) out.push(msg);
      }
    }
  }
  return out;
}

async function graph(path: string, init?: RequestInit) {
  const res = await fetch(`${GRAPH}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${config.WHATSAPP_TOKEN}`, "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`whatsapp ${path} ${res.status}: ${await res.text()}`);
  return res;
}

export const whatsapp: ChannelAdapter = {
  name: "whatsapp",
  async send(to, text, opts?: OutboundOptions) {
    const parts = splitMessage(formatForChannel(text, "whatsapp"));
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      const quick = last ? opts?.quickReplies?.slice(0, 3) : undefined;
      const payload =
        quick?.length && part.length <= 1024
          ? {
              messaging_product: "whatsapp",
              to,
              type: "interactive",
              interactive: {
                type: "button",
                body: { text: part },
                action: {
                  buttons: quick.map((t, idx) => ({ type: "reply", reply: { id: `qr_${idx}`, title: t.slice(0, 20) } })),
                },
              },
            }
          : { messaging_product: "whatsapp", to, type: "text", text: { body: part, preview_url: false } };
      await graph(`${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, { method: "POST", body: JSON.stringify(payload) });
    }
  },
  async downloadAudio(mediaId) {
    const meta = (await (await graph(mediaId)).json()) as { url: string; mime_type: string };
    const res = await fetch(meta.url, { headers: { authorization: `Bearer ${config.WHATSAPP_TOKEN}` } });
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: meta.mime_type };
  },
};
