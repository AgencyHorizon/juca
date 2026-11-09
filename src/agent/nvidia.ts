import { config } from "../config.js";
import type { StoredMessage } from "../core/conversation.js";
import type { PendingAction, User } from "../core/users.js";
import { logger } from "../lib/logger.js";
import { errors, llmTokens } from "../lib/metrics.js";
import { executeTool, type ToolOutcome } from "./tools.js";
import type { ToolContext } from "./connector-tools.js";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Agente sobre a NVIDIA NIM (API compatível com chat completions em integrate.api.nvidia.com).
 * Modelo principal rápido + modelo reserva usado quando o principal falha ou estoura o tempo.
 */
const BASE = "https://integrate.api.nvidia.com/v1/chat/completions";
const MAX_STEPS = 6;

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface NvidiaResult {
  text: string | null;
  pending?: PendingAction;
  usage: { input: number; output: number };
  model: string;
}

/** Converte as definições de ferramenta (formato Anthropic) para o formato function-calling. */
export function toFunctionTools(tools: Anthropic.Beta.BetaTool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description ?? "", parameters: t.input_schema },
  }));
}

/** Remove raciocínio exposto por alguns modelos (<think>…</think>). */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();
}

async function complete(model: string, messages: ChatMessage[], tools: ReturnType<typeof toFunctionTools>, timeoutMs: number, toolChoice: "auto" | "none" = "auto") {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { authorization: `Bearer ${config.NVIDIA_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, tools, tool_choice: toolChoice, temperature: 0.3, max_tokens: 1500 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`nvidia llm ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as {
    choices: { message: { content: string | null; tool_calls?: ToolCall[] }; finish_reason: string }[];
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
}

export async function runNvidiaAgent(p: {
  user: User;
  system: string;
  history: StoredMessage[];
  userText: string;
  tools: Anthropic.Beta.BetaTool[];
  ctx: ToolContext;
}): Promise<NvidiaResult> {
  const tools = toFunctionTools(p.tools);
  const messages: ChatMessage[] = [{ role: "system", content: p.system }];
  for (const h of p.history) messages.push({ role: h.role, content: h.text });
  messages.push({ role: "user", content: p.userText });

  const usage = { input: 0, output: 0 };
  let pending: PendingAction | undefined;
  let model = config.NVIDIA_LLM_MODEL;

  let forceText = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    // Na última volta (ou após resposta vazia) o modelo só pode escrever: assim ele sempre relata o que fez.
    const choice = forceText || step === MAX_STEPS - 1 ? "none" : "auto";
    let data: Awaited<ReturnType<typeof complete>>;
    try {
      data = await complete(model, messages, tools, 25_000, choice);
    } catch (e) {
      errors.inc({ where: `llm:${model}` });
      if (!config.NVIDIA_LLM_FALLBACK_MODEL || model === config.NVIDIA_LLM_FALLBACK_MODEL) throw e;
      logger.warn({ err: e, model }, "modelo principal falhou, usando o reserva");
      model = config.NVIDIA_LLM_FALLBACK_MODEL;
      data = await complete(model, messages, tools, 60_000, choice);
    }
    usage.input += data.usage?.prompt_tokens ?? 0;
    usage.output += data.usage?.completion_tokens ?? 0;
    llmTokens.inc({ kind: "input" }, data.usage?.prompt_tokens ?? 0);
    llmTokens.inc({ kind: "output" }, data.usage?.completion_tokens ?? 0);

    const msg = data.choices[0]?.message;
    if (!msg) break;
    const calls = msg.tool_calls ?? [];
    if (!calls.length) {
      const text = stripReasoning(msg.content ?? "");
      if (!text && !pending && !forceText && step < MAX_STEPS - 1) {
        logger.warn({ model, step, finish: data.choices[0]?.finish_reason }, "modelo devolveu resposta vazia");
        forceText = true;
        continue;
      }
      return { text: pending ? pending.prompt : text || null, pending, usage, model };
    }

    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
    const results = await Promise.all(
      calls.map(async (c): Promise<ToolOutcome> => {
        let args: unknown;
        try {
          args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
        } catch {
          return { content: JSON.stringify({ error: "invalid_json", message: "Argumentos não são JSON válido." }), isError: true };
        }
        try {
          return await executeTool(p.user, c.function.name, args, p.ctx);
        } catch (e) {
          errors.inc({ where: `tool:${c.function.name}` });
          logger.error({ err: e, tool: c.function.name }, "falha na ferramenta");
          return { content: JSON.stringify({ error: "internal_error" }), isError: true };
        }
      }),
    );
    results.forEach((r, i) => {
      if (r.pending) pending = r.pending;
      messages.push({ role: "tool", tool_call_id: calls[i]!.id, content: r.content });
    });
    // Aprovação pendente: a pergunta exata sai do sistema, não há por que voltar ao modelo.
    const waiting = pending as PendingAction | undefined;
    if (waiting) return { text: waiting.prompt, pending: waiting, usage, model };
  }
  logger.warn({ model }, "agente terminou sem resposta");
  errors.inc({ where: "agent_max_steps" });
  return { text: pending ? pending.prompt : null, pending, usage, model };
}
