import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { audit } from "../core/audit.js";
import { addItems, allLists, getList, updateItems } from "../core/lists.js";
import { forgetFact, listFacts, rememberFact } from "../core/memories.js";
import { describeUserData, exportUserData } from "../core/privacy.js";
import { cancelReminder, createReminder, DomainError, listReminders, updateReminder } from "../core/reminders.js";
import { formatLocal } from "../core/time.js";
import { resolveTimezone } from "../core/onboarding.js";
import { updateUser, type PendingAction, type User } from "../core/users.js";
import { toolCalls } from "../lib/metrics.js";

type Tool = Anthropic.Beta.BetaTool;

const str = (description: string) => ({ type: "string", description });
const nullableStr = (description: string) => ({ type: ["string", "null"], description });
const obj = (properties: Record<string, unknown>): Tool["input_schema"] => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** Ferramentas próprias do Juca. Ordem determinística = prefixo de cache estável. */
export const CUSTOM_TOOLS: Tool[] = [
  {
    name: "create_reminder",
    description: "Cria um lembrete que o Juca vai enviar na hora marcada. Use horário LOCAL da pessoa.",
    input_schema: obj({
      text: str("O que lembrar, curto, ex.: 'ligar pro dentista'"),
      local_datetime: str("Data e hora local, formato YYYY-MM-DDTHH:mm"),
      recurrence: nullableStr("null para único; ou FREQ=DAILY | FREQ=WEEKDAYS | FREQ=WEEKLY;BYDAY=MO,WE | FREQ=MONTHLY"),
    }),
  },
  { name: "list_reminders", description: "Lista os lembretes ativos da pessoa, com ids.", input_schema: obj({}) },
  {
    name: "update_reminder",
    description: "Altera um lembrete existente (use list_reminders antes para achar o id). Campos null não mudam.",
    input_schema: obj({
      reminder_id: { type: "integer" },
      text: nullableStr("novo texto ou null"),
      local_datetime: nullableStr("nova data/hora local YYYY-MM-DDTHH:mm ou null"),
      recurrence: nullableStr("nova recorrência, 'NONE' para remover, ou null para manter"),
    }),
  },
  {
    name: "cancel_reminder",
    description: "Cancela um lembrete (use list_reminders antes para achar o id).",
    input_schema: obj({ reminder_id: { type: "integer" } }),
  },
  {
    name: "add_to_list",
    description: "Adiciona itens a uma lista (cria se não existir). Ex.: compras, tarefas, filmes. Use 'geral' para anotações soltas.",
    input_schema: obj({ list_name: str("nome da lista"), items: { type: "array", items: { type: "string" } } }),
  },
  { name: "get_list", description: "Mostra os itens de uma lista, numerados.", input_schema: obj({ list_name: str("nome da lista") }) },
  { name: "list_lists", description: "Mostra todas as listas e quantos itens pendentes cada uma tem.", input_schema: obj({}) },
  {
    name: "update_list_items",
    description: "Remove itens ou marca como feitos, pelo número exibido em get_list.",
    input_schema: obj({
      list_name: str("nome da lista"),
      item_numbers: { type: "array", items: { type: "integer" } },
      action: { type: "string", enum: ["remove", "done"] },
    }),
  },
  {
    name: "clear_list",
    description: "Apaga uma lista inteira. Irreversível: o sistema pedirá confirmação à pessoa.",
    input_schema: obj({ list_name: str("nome da lista") }),
  },
  {
    name: "remember_fact",
    description: "Guarda um fato estável que a pessoa contou sobre si (não sensível). Ex.: key 'aniversario', value '12 de março'.",
    input_schema: obj({ key: str("chave curta"), value: str("valor") }),
  },
  { name: "forget_fact", description: "Esquece um fato guardado.", input_schema: obj({ key: str("chave do fato") }) },
  { name: "get_my_data", description: "Resumo do que o Juca sabe sobre a pessoa ('o que você sabe sobre mim?').", input_schema: obj({}) },
  { name: "export_my_data", description: "Exporta todos os dados da pessoa em texto legível ('me manda meus dados').", input_schema: obj({}) },
  {
    name: "delete_all_my_data",
    description: "Apaga TODOS os dados da pessoa e encerra a conta. Irreversível: o sistema pedirá confirmação.",
    input_schema: obj({}),
  },
  { name: "pause_juca", description: "Pausa o Juca: ele para de responder até a pessoa mandar 'voltar'. Lembretes continuam.", input_schema: obj({}) },
  {
    name: "update_profile",
    description: "Atualiza nome, fuso (cidade) ou autorização de uso anônimo dos dados para melhorar o Juca. Campos null não mudam.",
    input_schema: obj({
      name: nullableStr("novo nome ou null"),
      city_or_timezone: nullableStr("cidade ou fuso IANA, ou null"),
      training_consent: { type: ["boolean", "null"] },
    }),
  },
].map((t) => ({ ...t, strict: true }) as Tool);

/** Ferramentas de servidor da Anthropic para RF-14 (pesquisa) e RF-15 (resumo de links). */
export function serverTools(opts: { webSearch: boolean; linkSummary: boolean; country?: string; timezone: string }) {
  const tools: Anthropic.Beta.BetaToolUnion[] = [];
  if (opts.webSearch)
    tools.push({
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 3,
      user_location: { type: "approximate", country: opts.country ?? "BR", timezone: opts.timezone },
    });
  if (opts.linkSummary)
    tools.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: 2, max_content_tokens: 20000 });
  return tools;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  /** Ação irreversível que agora aguarda confirmação (RF-18) */
  pending?: PendingAction;
}

const PENDING_TTL_MS = 10 * 60_000;

const ReminderIn = z.object({ text: z.string().min(1).max(300), local_datetime: z.string(), recurrence: z.string().nullable() });
const UpdateReminderIn = z.object({ reminder_id: z.number().int(), text: z.string().nullable(), local_datetime: z.string().nullable(), recurrence: z.string().nullable() });
const IdIn = z.object({ reminder_id: z.number().int() });
const ListItemsIn = z.object({ list_name: z.string(), items: z.array(z.string()) });
const ListNameIn = z.object({ list_name: z.string() });
const UpdateItemsIn = z.object({ list_name: z.string(), item_numbers: z.array(z.number().int()), action: z.enum(["remove", "done"]) });
const FactIn = z.object({ key: z.string(), value: z.string() });
const KeyIn = z.object({ key: z.string() });
const ProfileIn = z.object({ name: z.string().nullable(), city_or_timezone: z.string().nullable(), training_consent: z.boolean().nullable() });

const ok = (data: unknown): ToolOutcome => ({ content: JSON.stringify(data) });

export async function executeTool(user: User, name: string, rawInput: unknown): Promise<ToolOutcome> {
  const tz = user.timezone;
  try {
    const out = await run();
    toolCalls.inc({ tool: name, outcome: out.isError ? "error" : out.pending ? "pending" : "ok" });
    return out;
  } catch (e) {
    if (e instanceof DomainError) {
      toolCalls.inc({ tool: name, outcome: "domain_error" });
      return { content: JSON.stringify({ error: e.code, message: e.message }), isError: true };
    }
    if (e instanceof z.ZodError) {
      toolCalls.inc({ tool: name, outcome: "invalid_input" });
      return { content: JSON.stringify({ error: "invalid_input", issues: e.issues.map((i) => i.message) }), isError: true };
    }
    throw e;
  }

  async function run(): Promise<ToolOutcome> {
    switch (name) {
      case "create_reminder": {
        const i = ReminderIn.parse(rawInput);
        const r = await createReminder(user.id, tz, i.text, i.local_datetime, i.recurrence);
        await audit(user.id, "agent", "reminder_created", { reminder_id: r.id, recurring: !!r.rrule });
        return ok({ id: r.id, text: r.text, when: formatLocal(r.dueAt, tz), recurrence: r.rrule });
      }
      case "list_reminders": {
        const rs = await listReminders(user.id);
        return ok(rs.map((r) => ({ id: r.id, text: r.text, when: formatLocal(r.dueAt, tz), recurrence: r.rrule })));
      }
      case "update_reminder": {
        const i = UpdateReminderIn.parse(rawInput);
        const r = await updateReminder(user.id, tz, i.reminder_id, {
          text: i.text ?? undefined,
          localDateTime: i.local_datetime ?? undefined,
          rrule: i.recurrence === null ? undefined : i.recurrence.toUpperCase() === "NONE" ? null : i.recurrence,
        });
        await audit(user.id, "agent", "reminder_updated", { reminder_id: r.id });
        return ok({ id: r.id, text: r.text, when: formatLocal(r.dueAt, tz), recurrence: r.rrule });
      }
      case "cancel_reminder": {
        const i = IdIn.parse(rawInput);
        const r = await cancelReminder(user.id, i.reminder_id);
        await audit(user.id, "agent", "reminder_cancelled", { reminder_id: r.id });
        return ok({ cancelled: { id: r.id, text: r.text, when: formatLocal(r.dueAt, tz) } });
      }
      case "add_to_list": {
        const i = ListItemsIn.parse(rawInput);
        return ok(await addItems(user.id, i.list_name, i.items));
      }
      case "get_list": {
        const i = ListNameIn.parse(rawInput);
        return ok((await getList(user.id, i.list_name)) ?? { error: "not_found", available: await allLists(user.id) });
      }
      case "list_lists":
        return ok(await allLists(user.id));
      case "update_list_items": {
        const i = UpdateItemsIn.parse(rawInput);
        return ok(await updateItems(user.id, i.list_name, i.item_numbers, i.action));
      }
      case "clear_list": {
        const i = ListNameIn.parse(rawInput);
        const list = await getList(user.id, i.list_name);
        if (!list) throw new DomainError("not_found", "Lista não encontrada.");
        const prompt = `Quer mesmo apagar a lista "${list.name}" inteira (${list.items.length} itens)? Responda SIM para confirmar.`;
        return {
          content: JSON.stringify({ status: "awaiting_user_confirmation", ask_user: prompt }),
          pending: { kind: "clear_list", args: { list_name: list.name }, prompt, expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString() },
        };
      }
      case "remember_fact": {
        const i = FactIn.parse(rawInput);
        return ok({ saved: await rememberFact(user.id, i.key, i.value) });
      }
      case "forget_fact": {
        const i = KeyIn.parse(rawInput);
        await forgetFact(user.id, i.key);
        return ok({ forgotten: i.key });
      }
      case "get_my_data":
        return ok({ summary: await describeUserData(user) });
      case "export_my_data":
        return ok({ export_text_to_send_verbatim: await exportUserData(user) });
      case "delete_all_my_data": {
        const prompt =
          "Isso vai apagar TUDO que eu sei sobre você — lembretes, listas, memórias e histórico — e encerrar sua conta. Não dá pra desfazer. Confirma? Responda SIM para apagar.";
        return {
          content: JSON.stringify({ status: "awaiting_user_confirmation", ask_user: prompt }),
          pending: { kind: "delete_all_data", args: {}, prompt, expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString() },
        };
      }
      case "pause_juca": {
        await updateUser(user.id, { status: "paused" });
        await audit(user.id, "user", "paused");
        return ok({ paused: true, resume_command: "voltar" });
      }
      case "update_profile": {
        const i = ProfileIn.parse(rawInput);
        const patch: Record<string, unknown> = {};
        if (i.name) patch.name = i.name.slice(0, 40);
        if (i.city_or_timezone) {
          const tzNew = resolveTimezone(i.city_or_timezone);
          if (!tzNew) throw new DomainError("unknown_city", "Não reconheci essa cidade/fuso.");
          patch.timezone = tzNew;
        }
        if (i.training_consent !== null) patch.training_consent = i.training_consent;
        const u = await updateUser(user.id, patch);
        Object.assign(user, u);
        if (i.training_consent !== null) await audit(user.id, "user", "training_consent_changed", { value: i.training_consent });
        return ok({ name: u.name, timezone: u.timezone, training_consent: u.training_consent });
      }
      default:
        return { content: JSON.stringify({ error: "unknown_tool" }), isError: true };
    }
  }
}

export { listFacts };
