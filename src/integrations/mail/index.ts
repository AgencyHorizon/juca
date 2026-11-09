import { createHash } from "node:crypto";
import type { OAuthProvider } from "../oauth.js";
import { gmailClient } from "./gmail.js";
import { outlookClient } from "./outlook.js";
import type { Draft, MailClient } from "./types.js";

export const mailClients: Record<OAuthProvider, MailClient> = { google: gmailClient, microsoft: outlookClient };

/** Impressão digital do rascunho: se mudar entre a pergunta e o "sim", o envio é recusado. */
export const draftHash = (d: Draft) => createHash("sha256").update(JSON.stringify([d.to, d.subject, d.body])).digest("hex");

export type { Draft } from "./types.js";
