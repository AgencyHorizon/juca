import type { ChannelName } from "./types.js";

// RF-09: adapta a resposta às limitações de cada canal.
// O modelo escreve em "markdown leve" (**negrito**, listas com "-").
export function formatForChannel(text: string, channel: ChannelName | "sms"): string {
  let t = text.trim();
  t = t.replace(/^#{1,6}\s+/gm, ""); // títulos não existem em canais de mensagem
  switch (channel) {
    case "whatsapp":
      // WhatsApp: *negrito*, _itálico_, ~tachado~
      t = t.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/~~(.+?)~~/g, "~$1~");
      t = t.replace(/^\s*[-*]\s+/gm, "• ");
      break;
    case "telegram":
      // Enviado como texto puro (sem parse_mode) para nunca falhar por escape.
      t = t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/~~(.+?)~~/g, "$1");
      t = t.replace(/^\s*[-*]\s+/gm, "• ");
      break;
    case "sms":
      t = t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/[*_~`]/g, "");
      t = t.replace(/^\s*[-•]\s+/gm, "- ");
      break;
  }
  return t;
}

/** Quebra mensagens longas respeitando parágrafos (limite ~4096 nos dois canais). */
export function splitMessage(text: string, max = 3500): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    if (cur && (cur + "\n\n" + para).length > max) {
      parts.push(cur);
      cur = para;
    } else {
      cur = cur ? cur + "\n\n" + para : para;
    }
    while (cur.length > max) {
      parts.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur) parts.push(cur);
  return parts;
}
