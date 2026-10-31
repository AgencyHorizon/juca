import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { isEnabled } from "../core/flags.js";
import { listFacts } from "../core/memories.js";
import { nowLocalDescription } from "../core/time.js";
import type { PendingAction, User } from "../core/users.js";
import type { StoredMessage } from "../core/conversation.js";
import { logger } from "../lib/logger.js";
import { errors, llmTokens } from "../lib/metrics.js";
import { systemPrompt, userContext } from "./prompts.js";
import { CUSTOM_TOOLS, executeTool, serverTools } from "./tools.js";

const client = new Anthropic({ maxRetries: 3, timeout: 60_000 }); // RNF-25: retry com backoff exponencial do SDK

const MAX_STEPS = 8;
// Modelos que aceitam o fallback de recusa no servidor (forma "default")
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export const FRIENDLY_FAILURE = "Tive um problema pra fazer isso agora 😕 Pode tentar de novo daqui a pouquinho?";

export interface AgentResult {
  text: string;
  pending?: PendingAction;
  usage: { input: number; output: number };
  model: string;
}

/** RNF-12: higieniza a entrada (remove caracteres de controle, limita tamanho). */
export function sanitizeInput(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "").slice(0, 4000);
}

function toMessages(history: StoredMessage[], current: string): Anthropic.Beta.BetaMessageParam[] {
  const msgs: Anthropic.Beta.BetaMessageParam[] = [];
  for (const h of history) {
    const last = msgs[msgs.length - 1];
    // a API exige começar com "user"; turnos consecutivos do mesmo papel são mesclados
    if (!last && h.role === "assistant") continue;
    if (last && last.role === h.role) last.content = `${last.content as string}\n\n${h.text}`;
    else msgs.push({ role: h.role, content: h.text });
  }
  const last = msgs[msgs.length - 1];
  if (last?.role === "user") last.content = `${last.content as string}\n\n${current}`;
  else msgs.push({ role: "user", content: current });
  return msgs;
}

export async function runAgent(user: User, history: StoredMessage[], userText: string, opts: { newSession: boolean }): Promise<AgentResult> {
  const model = config.JUCA_MODEL;
  const [facts, webSearch, linkSummary, memoryOn] = await Promise.all([
    listFacts(user.id),
    isEnabled("web_search", user),
    isEnabled("link_summary", user),
    isEnabled("persistent_memory", user),
  ]);

  const tools: Anthropic.Beta.BetaToolUnion[] = [
    ...CUSTOM_TOOLS.filter((t) => memoryOn || (t.name !== "remember_fact" && t.name !== "forget_fact")),
    ...serverTools({ model, webSearch, linkSummary, timezone: user.timezone }),
  ];

  // Prefixo estável (ferramentas + prompt do sistema) cacheado; contexto dinâmico vem depois do breakpoint.
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: systemPrompt(config.PROMPT_VERSION), cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: userContext({
        name: user.name,
        timezone: user.timezone,
        nowLocal: nowLocalDescription(user.timezone),
        facts: memoryOn ? facts : [],
        newSession: opts.newSession,
      }),
    },
  ];

  const messages = toMessages(history, sanitizeInput(userText));
  const usage = { input: 0, output: 0 };
  let pending: PendingAction | undefined;
  const useFallback = FALLBACK_MODELS.has(model);

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 8000,
      system,
      tools,
      messages,
      output_config: { effort: config.JUCA_EFFORT },
      ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });

    usage.input += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
    usage.output += response.usage.output_tokens;
    llmTokens.inc({ kind: "input" }, response.usage.input_tokens);
    llmTokens.inc({ kind: "cache_read" }, response.usage.cache_read_input_tokens ?? 0);
    llmTokens.inc({ kind: "output" }, response.usage.output_tokens);

    if (response.stop_reason === "refusal") {
      logger.warn({ category: response.stop_details?.category }, "recusa do modelo");
      return { text: "Desculpa, nisso eu não consigo ajudar. Posso te ajudar com outra coisa?", usage, model };
    }

    // devolve o conteúdo completo (inclui blocos de thinking/servidor) para a próxima iteração
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") continue;

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (response.stop_reason === "max_tokens" && !text) break;
      // se uma ação aguarda confirmação, a pergunta exata é enviada pelo sistema (vinculada ao texto mostrado)
      return { text: pending ? pending.prompt : text || FRIENDLY_FAILURE, pending, usage, model };
    }

    // executa as ferramentas em paralelo e devolve TODOS os resultados numa única mensagem
    const results = await Promise.all(
      toolUses.map(async (tu): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        try {
          const out = await executeTool(user, tu.name, tu.input);
          if (out.pending) pending = out.pending;
          return { type: "tool_result", tool_use_id: tu.id, content: out.content, is_error: out.isError };
        } catch (e) {
          errors.inc({ where: `tool:${tu.name}` });
          logger.error({ err: e, tool: tu.name }, "falha na ferramenta");
          return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ error: "internal_error" }), is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }

  errors.inc({ where: "agent_max_steps" });
  return { text: pending ? pending.prompt : FRIENDLY_FAILURE, pending, usage, model };
}
