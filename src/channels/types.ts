export type ChannelName = "whatsapp" | "telegram";

/** Mensagem normalizada, independente do canal. */
export interface InboundMessage {
  channel: ChannelName;
  externalUserId: string; // wa_id ou chat id do Telegram
  externalMessageId: string; // p/ idempotência (RNF-24)
  phone?: string; // E.164 sem "+", quando o canal fornece
  displayName?: string;
  text?: string;
  audio?: { fileId: string; mimeType?: string };
  contactPhone?: string; // Telegram: contato compartilhado pelo próprio usuário
  receivedAt: string;
}

export interface OutboundOptions {
  /** Pede ao usuário que compartilhe o telefone (Telegram) */
  requestContact?: boolean;
  /** Botões de resposta rápida (ex.: Sim/Não em confirmações) */
  quickReplies?: string[];
}

export interface ChannelAdapter {
  name: ChannelName;
  send(externalUserId: string, text: string, opts?: OutboundOptions): Promise<void>;
  downloadAudio?(fileId: string): Promise<{ data: Buffer; mimeType: string }>;
}
