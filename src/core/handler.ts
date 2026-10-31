import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { channels } from "../channels/index.js";
import type { InboundMessage } from "../channels/types.js";
import { FRIENDLY_FAILURE, runAgent } from "../agent/agent.js";
import { correlation, logger } from "../lib/logger.js";
import { errors, messagesIn, replyLatency } from "../lib/metrics.js";
import { audit } from "./audit.js";
import { currentSession, markProcessed, rateLastReply, recentHistory, saveMessage } from "./conversation.js";
import { isEnabled } from "./flags.js";
import { clearList } from "./lists.js";
import { handleOnboarding, type OtpSender, type Reply } from "./onboarding.js";
import { deleteAllUserData } from "./privacy.js";
import { checkRateLimit } from "./ratelimit.js";
import { findOrCreateByChannel, updateUser, type User } from "./users.js";

/** Transcrição de áudio (RF-07). Plugável: configure um provedor de STT e ligue a flag voice_transcription. */
export interface Transcriber {
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}
let transcriber: Transcriber | null = null;
export function setTranscriber(t: Transcriber) {
  transcriber = t;
}

/**
 * Entrega do OTP (RF-02). Padrão: envia pelo próprio canal (útil em dev).
 * Em produção troque por SMS (setOtpSender) para que o código prove a posse do número.
 */
let otpSender: OtpSender = {
  async send(_user, msg, _phone, code) {
    await channels[msg.channel].send(msg.externalUserId, `Seu código do Juca: ${code}\nEle vale por 10 minutos. Não compartilhe com ninguém.`);
  },
};
export function setOtpSender(s: OtpSender) {
  otpSender = s;
}

const THUMBS_UP = /^\s*(👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿)\s*$/u;
const THUMBS_DOWN = /^\s*(👎|👎🏻|👎🏼|👎🏽|👎🏾|👎🏿)\s*$/u;
const PAUSE = /^\s*(pausar|pausa|para de responder|pause)\s*[.!]?\s*$/i;
const RESUME = /^\s*(voltar|volta|despausar|retomar|resume)\s*[.!]?\s*$/i;
const CONFIRM = /^\s*(sim|s|confirmo|confirmar|pode|pode apagar|isso|yes)\b/i;
const DENY = /^\s*(n[aã]o|nao|n|cancela|cancelar|deixa|no)\b/i;

// RN-20: heurística simples de tentativa de prompt injection / abuso
const INJECTION = [
  /ignore (all |todas )?(previous|prior|as) (instructions|instru[cç][oõ]es)/i,
  /ignor[ea] (suas|as) instru[cç][oõ]es/i,
  /(revele|mostre|print|reveal).{0,30}(system prompt|prompt do sistema|suas instru[cç][oõ]es)/i,
  /you are now (DAN|in developer mode)/i,
  /modo desenvolvedor/i,
];
const MAX_STRIKES = 5;

async function send(msg: InboundMessage, r: Reply) {
  await channels[msg.channel].send(msg.externalUserId, r.text, r.opts);
}

export async function handleInbound(msg: InboundMessage): Promise<void> {
  const started = Date.now();
  await correlation.run({ correlationId: randomUUID() }, async () => {
    messagesIn.inc({ channel: msg.channel });
    if (!(await markProcessed(msg.channel, msg.externalMessageId))) {
      logger.info("mensagem duplicada ignorada");
      return;
    }
    let user: User;
    try {
      const r = await findOrCreateByChannel(msg.channel, msg.externalUserId);
      user = r.user;
      const store = correlation.getStore();
      if (store) store.userId = user.id;
      if (user.status === "blocked") return;
      await updateUser(user.id, { last_seen_at: new Date() });

      const rl = await checkRateLimit(user.id);
      if (!rl.allowed) {
        if (rl.firstBlock)
          await send(msg, { text: `Opa, foram muitas mensagens em pouco tempo (limite de ${config.RATE_LIMIT_PER_HOUR} por hora). Me dá um respiro e tenta de novo daqui a pouco 🙏` });
        return;
      }

      if (user.status === "onboarding") {
        const ob = await handleOnboarding(user, msg, otpSender);
        for (const r of ob.replies) await send(msg, r);
        return;
      }

      await handleActive(user, msg, started);
    } catch (e) {
      errors.inc({ where: "handler" });
      logger.error({ err: e }, "falha ao processar mensagem");
      // RN-22: nunca código de erro para o usuário
      // Não relança: a mensagem já foi marcada como processada (idempotência) e o usuário já
      // recebeu um aviso. Retries de integração acontecem dentro do SDK da Anthropic e no envio.
      await send(msg, { text: FRIENDLY_FAILURE }).catch(() => {});
    }
  });
}

async function handleActive(user: User, msg: InboundMessage, started: number) {
  // --- Áudio (RF-07) ---
  let text = msg.text?.trim() ?? "";
  if (msg.audio) {
    const adapter = channels[msg.channel];
    if (!transcriber || !adapter.downloadAudio || !(await isEnabled("voice_transcription", user))) {
      await send(msg, { text: "Ainda não consigo ouvir áudios 🙉 Pode me mandar por texto?" });
      return;
    }
    const { data, mimeType } = await adapter.downloadAudio(msg.audio.fileId);
    text = (await transcriber.transcribe(data, mimeType)).trim();
    if (!text) {
      await send(msg, { text: "Não consegui entender o áudio. Pode repetir ou escrever?" });
      return;
    }
  }
  if (!text) return;

  // --- Pausa (RF-28) ---
  if (user.status === "paused") {
    if (RESUME.test(text)) {
      await updateUser(user.id, { status: "active" });
      await audit(user.id, "user", "resumed");
      await send(msg, { text: `Voltei${user.name ? `, ${user.name}` : ""}! 😄 Em que posso ajudar?` });
    }
    return; // pausado: silêncio (lembretes continuam sendo enviados)
  }
  if (PAUSE.test(text)) {
    await updateUser(user.id, { status: "paused" });
    await audit(user.id, "user", "paused");
    await send(msg, { text: "Beleza, fico quietinho. Seus lembretes continuam valendo. Quando quiser, é só mandar “voltar”." });
    return;
  }

  // --- Feedback (RF-29) ---
  if (THUMBS_UP.test(text) || THUMBS_DOWN.test(text)) {
    const up = THUMBS_UP.test(text);
    await rateLastReply(user.id, up ? 1 : -1);
    if (!up) await send(msg, { text: "Valeu pelo toque! Me conta o que eu poderia ter feito melhor?" });
    return;
  }

  // --- Confirmação de ação irreversível (RF-18 / RN-06) ---
  const pending = user.pending_action;
  if (pending) {
    await updateUser(user.id, { pending_action: null });
    const valid = new Date(pending.expiresAt).getTime() > Date.now();
    if (valid && CONFIRM.test(text)) {
      await executeConfirmed(user, msg, pending);
      return;
    }
    if (valid && DENY.test(text)) {
      await send(msg, { text: "Ok, não mexi em nada 👍" });
      return;
    }
    // qualquer outra coisa: a ação expira e a mensagem segue normalmente para o agente
  }

  // --- Abuso / prompt injection (RN-20) ---
  if (INJECTION.some((re) => re.test(text))) {
    const strikes = user.abuse_strikes + 1;
    await updateUser(user.id, { abuse_strikes: strikes });
    await audit(user.id, "system", "abuse_detected", { kind: "prompt_injection", strikes });
    if (strikes >= MAX_STRIKES) {
      await updateUser(user.id, { status: "blocked" });
      await audit(user.id, "system", "user_auto_suspended", { reason: "prompt_injection" });
      await send(msg, { text: "Por segurança, sua conta foi suspensa. Se achar que foi um engano, escreve pra suporte@juca.app." });
      return;
    }
  }

  // --- Agente ---
  const session = await currentSession(user.id);
  const history = await recentHistory(session.id);
  await saveMessage({ userId: user.id, sessionId: session.id, role: "user", channel: msg.channel, text });

  const result = await runAgent(user, history, text, { newSession: session.isNew });
  if (result.pending) await updateUser(user.id, { pending_action: result.pending });

  await send(msg, { text: result.text, opts: result.pending ? { quickReplies: ["Sim", "Não"] } : undefined });
  const latency = Date.now() - started;
  replyLatency.observe({ channel: msg.channel }, latency / 1000);
  await saveMessage({
    userId: user.id,
    sessionId: session.id,
    role: "assistant",
    channel: msg.channel,
    text: result.text,
    promptVersion: config.PROMPT_VERSION,
    model: result.model,
    inputTokens: result.usage.input,
    outputTokens: result.usage.output,
    latencyMs: latency,
  });
  logger.info({ latencyMs: latency, tokens: result.usage }, "resposta enviada");
}

async function executeConfirmed(user: User, msg: InboundMessage, pending: NonNullable<User["pending_action"]>) {
  switch (pending.kind) {
    case "delete_all_data":
      // envia a despedida antes: depois da exclusão não há mais vínculo com o canal
      await send(msg, { text: "Pronto. Apaguei tudo que eu sabia sobre você e encerrei sua conta. Foi bom te ajudar! Se quiser voltar, é só mandar um oi 👋" });
      await deleteAllUserData(user.id);
      return;
    case "clear_list":
      await clearList(user.id, String(pending.args.list_name));
      await audit(user.id, "user", "list_cleared");
      await send(msg, { text: `Feito, apaguei a lista "${pending.args.list_name}".` });
      return;
    default:
      await send(msg, { text: FRIENDLY_FAILURE });
  }
}
