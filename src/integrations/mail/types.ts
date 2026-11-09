/** Contrato comum de e-mail: as ferramentas do agente não sabem se é Gmail ou Outlook. */
export interface MailSearch {
  text?: string | null;
  from?: string | null;
  unreadOnly?: boolean;
  newerThanDays?: number | null;
  max?: number;
}

export interface MailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface MailFull extends MailSummary {
  to: string;
  body: string;
}

export interface DraftInput {
  to: string;
  subject: string;
  body: string;
  replyToId?: string;
}

export interface Draft {
  id: string;
  to: string;
  subject: string;
  body: string;
}

export interface MailClient {
  search(userId: number, q: MailSearch): Promise<MailSummary[]>;
  read(userId: number, id: string): Promise<MailFull>;
  createDraft(userId: number, d: DraftInput): Promise<{ draftId: string }>;
  /** Lê o rascunho como ele está no provedor: é isso que a confirmação mostra. */
  getDraft(userId: number, draftId: string): Promise<Draft>;
  sendDraft(userId: number, draftId: string): Promise<void>;
}

export const MAX_BODY = 4000;
