import { config } from "../config.js";
import { safeEqual } from "../lib/crypto.js";
import { formatForChannel, splitMessage } from "./format.js";
import type { ChannelAdapter, InboundMessage, OutboundOptions } from "./types.js";

const api = (method: string) => `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`;

// RNF-10: o Telegram envia o secret configurado no setWebhook neste header
export function verifyTelegram(headers: Record<string, unknown>): boolean {
  const got = headers["x-telegram-bot-api-secret-token"];
  return !!config.TELEGRAM_WEBHOOK_SECRET && typeof got === "string" && safeEqual(got, config.TELEGRAM_WEBHOOK_SECRET);
}

export function parseTelegram(update: any): InboundMessage | null {
  const m = update?.message;
  if (!m || m.chat?.type !== "private") return null;
  const msg: InboundMessage = {
    channel: "telegram",
    externalUserId: String(m.chat.id),
    externalMessageId: String(update.update_id),
    displayName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || undefined,
    receivedAt: new Date((m.date ?? Date.now() / 1000) * 1000).toISOString(),
  };
  if (typeof m.text === "string") msg.text = m.text;
  // Só aceita o contato se for do próprio remetente (evita vincular número de terceiros)
  if (m.contact?.phone_number && m.contact.user_id === m.from?.id) {
    msg.contactPhone = String(m.contact.phone_number).replace(/\D/g, "");
  }
  const voice = m.voice ?? m.audio;
  if (voice?.file_id) msg.audio = { fileId: voice.file_id, mimeType: voice.mime_type };
  if (!msg.text && !msg.contactPhone && !msg.audio) return null;
  return msg;
}

async function call(method: string, body: unknown): Promise<any> {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`telegram ${method} ${res.status}: ${await res.text()}`);
  return res.json();
}

export const telegram: ChannelAdapter = {
  name: "telegram",
  async send(chatId, text, opts?: OutboundOptions) {
    const parts = splitMessage(formatForChannel(text, "telegram"));
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      let reply_markup: unknown = { remove_keyboard: true };
      if (last && opts?.requestContact) {
        reply_markup = {
          keyboard: [[{ text: "📱 Compartilhar meu número", request_contact: true }]],
          one_time_keyboard: true,
          resize_keyboard: true,
        };
      } else if (last && opts?.quickReplies?.length) {
        reply_markup = {
          keyboard: [opts.quickReplies.map((t) => ({ text: t }))],
          one_time_keyboard: true,
          resize_keyboard: true,
        };
      }
      await call("sendMessage", { chat_id: chatId, text: part, reply_markup });
    }
  },
  async ack(msg) {
    await call("sendChatAction", { chat_id: msg.externalUserId, action: "typing" });
  },
  async downloadAudio(fileId) {
    const info = await call("getFile", { file_id: fileId });
    const res = await fetch(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${info.result.file_path}`);
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: "audio/ogg" };
  },
};

export async function registerTelegramWebhook() {
  return call("setWebhook", {
    url: `${config.PUBLIC_BASE_URL}/webhooks/telegram`,
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"],
  });
}
