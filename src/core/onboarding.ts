import { randomInt } from "node:crypto";
import { config, DEFAULT_TIMEZONE, TERMS_VERSION } from "../config.js";
import { sha256 } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import type { InboundMessage, OutboundOptions } from "../channels/types.js";
import { audit } from "./audit.js";
import { isValidTimezone } from "./time.js";
import { countActiveUsers, mergeIntoExistingByPhone, updateUser, type User } from "./users.js";

export interface Reply {
  text: string;
  opts?: OutboundOptions;
}

/**
 * Fluxo de onboarding conversacional (RF-01..RF-04, RN-02, RN-03, RN-21, RN-25).
 * Passos: start → [await_contact] → await_otp → await_terms → ask_name → ask_timezone → active
 */
export const TERMS_SUMMARY = [
  "Antes de começar, o resumo dos termos (versão completa: juca.app/termos):",
  "• Sou uma IA, não uma pessoa. Posso errar — confira o que for importante.",
  "• Guardo suas mensagens por até 90 dias e o que você pedir pra eu lembrar. Tudo cifrado.",
  "• Não guardo dados sensíveis (saúde, finanças, documentos, senhas).",
  "• Não uso seus dados pra treinar modelos, a não ser que você autorize.",
  "• Você pode pedir “o que você sabe sobre mim”, “me manda meus dados” ou “apaga tudo” a qualquer hora.",
  "• O Juca é só para maiores de 18 anos.",
  "",
  "Se concorda e tem 18 anos ou mais, responda *ACEITO*.",
].join("\n");

const YES = /^(sim|s|aceito|aceitar|concordo|ok|pode|claro|isso|confirmo|yes|y)\b/i;
const NO = /^(n[aã]o|nao|n|no|recuso)\b/i;

const CITY_TZ: Record<string, string> = {
  "sao paulo": "America/Sao_Paulo", "rio": "America/Sao_Paulo", "rio de janeiro": "America/Sao_Paulo", "brasilia": "America/Sao_Paulo",
  "belo horizonte": "America/Sao_Paulo", "curitiba": "America/Sao_Paulo", "porto alegre": "America/Sao_Paulo", "salvador": "America/Bahia",
  "recife": "America/Recife", "fortaleza": "America/Fortaleza", "belem": "America/Belem", "manaus": "America/Manaus",
  "cuiaba": "America/Cuiaba", "campo grande": "America/Campo_Grande", "porto velho": "America/Porto_Velho", "rio branco": "America/Rio_Branco",
  "boa vista": "America/Boa_Vista", "noronha": "America/Noronha", "fernando de noronha": "America/Noronha",
  "lisboa": "Europe/Lisbon", "porto": "Europe/Lisbon", "londres": "Europe/London", "nova york": "America/New_York", "new york": "America/New_York",
  "miami": "America/New_York", "orlando": "America/New_York", "boston": "America/New_York", "toronto": "America/Toronto",
  "madri": "Europe/Madrid", "paris": "Europe/Paris", "berlim": "Europe/Berlin", "dublin": "Europe/Dublin",
  "sao francisco": "America/Los_Angeles", "los angeles": "America/Los_Angeles", "buenos aires": "America/Argentina/Buenos_Aires",
  "santiago": "America/Santiago", "toquio": "Asia/Tokyo", "sydney": "Australia/Sydney",
};

export function resolveTimezone(input: string): string | null {
  const t = input.trim();
  if (isValidTimezone(t) && t.includes("/")) return t;
  const key = t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, "").trim();
  if (CITY_TZ[key]) return CITY_TZ[key];
  for (const [city, tz] of Object.entries(CITY_TZ)) if (key.includes(city)) return tz;
  return null;
}

/** Remove saudações e pega um primeiro nome plausível. */
export function extractName(input: string): string | null {
  const t = input
    .trim()
    .replace(/^(oi|ol[aá]|e a[ií])[,!.\s]*/i, "")
    .replace(/^(meu nome [eé]|me chamo|sou o|sou a|sou|pode me chamar de|[eé])\s+/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!t || t.length > 40 || /\d/.test(t) || t.split(/\s+/).length > 4) return null;
  // \b é ASCII-only (quebraria "João" → "JoÃO"); capitaliza a 1ª letra de cada palavra
  return t.replace(/(^|\s)(\p{L})/gu, (_m, sp: string, c: string) => sp + c.toUpperCase());
}

export interface OtpSender {
  send(user: User, msg: InboundMessage, phone: string, code: string): Promise<void>;
}

async function startOtp(user: User, phone: string, msg: InboundMessage, otp: OtpSender): Promise<Reply> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await updateUser(user.id, {
    phone,
    otp_hash: sha256(`${user.id}:${code}`),
    otp_expires_at: new Date(Date.now() + 10 * 60_000),
    otp_attempts: 0,
    onboarding_step: "await_otp",
  });
  await otp.send(user, msg, phone, code);
  return { text: "Te mandei um código de 6 dígitos pra confirmar que esse número é seu. Me responde com ele aqui 🙂" };
}

export async function handleOnboarding(user: User, msg: InboundMessage, otp: OtpSender): Promise<{ user: User; replies: Reply[] }> {
  const text = (msg.text ?? "").trim();
  const replies: Reply[] = [];
  let u = user;

  switch (u.onboarding_step) {
    case "start": {
      // RN-25: beta fechado limitado
      if ((await countActiveUsers()) > config.BETA_USER_CAP) {
        await updateUser(u.id, { onboarding_step: "waitlist" });
        return { user: u, replies: [{ text: "Oi! Eu sou o Juca 👋 Estou em beta fechado e as vagas acabaram por enquanto. Te aviso aqui assim que abrir mais!" }] };
      }
      // RN-21: deixa claro que é uma IA logo na primeira interação
      replies.push({
        text: "Oi! Eu sou o Juca 👋 Sou um assistente de inteligência artificial (não sou uma pessoa) que vive aqui no seu chat. Você me pede coisas como pediria a um amigo — lembretes, listas, pesquisas, textos — e eu resolvo.",
      });
      if (msg.phone) {
        replies.push(await startOtp(u, msg.phone, msg, otp));
      } else {
        await updateUser(u.id, { onboarding_step: "await_contact" });
        replies.push({ text: "Pra começar, toca no botão abaixo pra compartilhar seu número. É só pra criar sua conta com segurança.", opts: { requestContact: true } });
      }
      break;
    }
    case "await_contact": {
      if (!msg.contactPhone) {
        replies.push({ text: "Preciso do seu número pra continuar — é só tocar no botão “Compartilhar meu número” 👇", opts: { requestContact: true } });
        break;
      }
      replies.push(await startOtp(u, msg.contactPhone, msg, otp));
      break;
    }
    case "await_otp": {
      const code = text.replace(/\D/g, "");
      if (u.otp_expires_at && new Date(u.otp_expires_at).getTime() < Date.now()) {
        replies.push(await startOtp(u, u.phone!, msg, otp));
        replies.unshift({ text: "Esse código expirou, mandei outro." });
        break;
      }
      if (code.length !== 6) {
        replies.push({ text: "Me manda só os 6 números do código, por favor." });
        break;
      }
      if (u.otp_attempts >= 5) {
        await updateUser(u.id, { status: "blocked" });
        await audit(u.id, "system", "otp_too_many_attempts");
        replies.push({ text: "Muitas tentativas erradas. Por segurança, bloqueei o cadastro. Fala com suporte@juca.app se precisar de ajuda." });
        break;
      }
      if (sha256(`${u.id}:${code}`) !== u.otp_hash) {
        await updateUser(u.id, { otp_attempts: u.otp_attempts + 1 });
        replies.push({ text: "Hmm, esse código não bateu. Confere e tenta de novo?" });
        break;
      }
      // RN-01 / RN-04: número já tem conta? vincula este canal a ela
      const merged = await mergeIntoExistingByPhone(u, u.phone!);
      if (merged.tooManyChannels) {
        replies.push({ text: "Esse número já está ligado a 2 canais, que é o máximo por enquanto. Desvincule um deles antes de usar este." });
        break;
      }
      if (merged.merged) {
        await audit(merged.user.id, "user", "channel_linked", { channel: msg.channel });
        const hi = merged.user.name ? `Pronto, ${merged.user.name}!` : "Pronto!";
        return { user: merged.user, replies: [{ text: `${hi} Conectei este chat à sua conta. Pode mandar o que precisar 😉` }] };
      }
      u = await updateUser(u.id, { phone_verified: true, otp_hash: null, otp_expires_at: null, onboarding_step: "await_terms" });
      await audit(u.id, "user", "phone_verified");
      replies.push({ text: "Número confirmado ✅" }, { text: TERMS_SUMMARY, opts: { quickReplies: ["ACEITO"] } });
      break;
    }
    case "await_terms": {
      if (NO.test(text)) {
        replies.push({ text: "Tudo bem! Sem aceitar os termos eu não consigo te ajudar. Se mudar de ideia, é só mandar ACEITO." });
        break;
      }
      if (!YES.test(text)) {
        // RN-02: antes do aceite, só o fluxo de onboarding
        replies.push({ text: "Pra eu poder te ajudar, preciso que você aceite os termos. Responde *ACEITO* se concorda e tem 18 anos ou mais.", opts: { quickReplies: ["ACEITO"] } });
        break;
      }
      u = await updateUser(u.id, { terms_version: TERMS_VERSION, terms_accepted_at: new Date(), is_adult: true, onboarding_step: "ask_name" });
      await audit(u.id, "user", "terms_accepted", { version: TERMS_VERSION, adult_declared: true });
      const suggestion = msg.displayName?.split(" ")[0];
      replies.push({
        text: suggestion ? `Perfeito! Posso te chamar de ${suggestion}? Se preferir outro nome, é só me dizer.` : "Perfeito! Como você quer que eu te chame?",
        opts: suggestion ? { quickReplies: ["Pode sim"] } : undefined,
      });
      break;
    }
    case "ask_name": {
      const suggestion = msg.displayName?.split(" ")[0];
      const name = YES.test(text) && suggestion ? suggestion : extractName(text);
      if (!name) {
        replies.push({ text: "Não peguei seu nome 😅 Como você quer que eu te chame?" });
        break;
      }
      u = await updateUser(u.id, { name, onboarding_step: "ask_timezone" });
      replies.push({ text: `Prazer, ${name}! Última pergunta: você está no horário de Brasília? Se não, me diz sua cidade.`, opts: { quickReplies: ["Sim", "Não"] } });
      break;
    }
    case "ask_timezone": {
      let tz: string | null = null;
      if (YES.test(text)) tz = DEFAULT_TIMEZONE;
      else if (NO.test(text) && text.split(/\s+/).length <= 2) {
        replies.push({ text: "Beleza! Em que cidade você está?" });
        break;
      } else tz = resolveTimezone(text);
      if (!tz) {
        replies.push({ text: "Não reconheci essa cidade. Pode mandar outra cidade próxima? (ou “Brasília” se for o horário de Brasília)" });
        break;
      }
      u = await updateUser(u.id, { timezone: tz, status: "active", onboarding_step: "done" });
      await audit(u.id, "user", "onboarding_completed", { timezone: tz });
      // RNF-19: primeira tarefa sem tutorial — exemplos concretos
      replies.push({
        text: [
          `Tudo pronto, ${u.name}! 🎉 Pode falar comigo do jeito que falaria com um amigo. Alguns exemplos:`,
          "• “Me lembra de ligar pro dentista amanhã às 10h”",
          "• “Anota que preciso comprar leite, pão e café”",
          "• “Vai chover em SP amanhã?”",
          "• “Escreve uma mensagem pro meu chefe avisando que vou atrasar”",
          "",
          "O que posso fazer por você agora?",
        ].join("\n"),
      });
      break;
    }
    case "waitlist":
      replies.push({ text: "Você está na lista de espera do beta. Te aviso aqui assim que abrir uma vaga 🙏" });
      break;
    default:
      logger.warn({ step: u.onboarding_step }, "passo de onboarding desconhecido");
      await updateUser(u.id, { onboarding_step: "start" });
      replies.push({ text: "Vamos recomeçar rapidinho. Me manda um oi 🙂" });
  }
  return { user: u, replies };
}
