import { config } from "../config.js";
import { query } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { localToUtc, parseRrule } from "./time.js";

export interface Reminder {
  id: number;
  text: string;
  dueAt: Date;
  rrule: string | null;
}

export class DomainError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function row(r: any): Reminder {
  return { id: Number(r.id), text: decrypt(r.text_enc), dueAt: r.due_at, rrule: r.rrule };
}

export async function createReminder(userId: number, tz: string, text: string, localDateTime: string, rrule?: string | null): Promise<Reminder> {
  const due = localToUtc(localDateTime, tz);
  if (!due) throw new DomainError("invalid_datetime", "Data/hora inválida.");
  // RN-13: horário no passado é rejeitado (tolerância de 30s)
  if (due.toMillis() < Date.now() - 30_000) throw new DomainError("past_datetime", "Esse horário já passou.");
  if (rrule && !parseRrule(rrule)) throw new DomainError("invalid_rrule", "Recorrência não suportada.");
  // RN-12: máximo de lembretes ativos
  const { rows } = await query<{ n: string }>("SELECT count(*) n FROM reminders WHERE user_id = $1 AND status = 'active'", [userId]);
  if (Number(rows[0]!.n) >= config.MAX_ACTIVE_REMINDERS) {
    throw new DomainError("limit_reached", `Limite de ${config.MAX_ACTIVE_REMINDERS} lembretes ativos atingido.`);
  }
  const r = await query(
    "INSERT INTO reminders(user_id, text_enc, due_at, rrule) VALUES ($1,$2,$3,$4) RETURNING *",
    [userId, encrypt(text), due.toJSDate(), rrule ?? null],
  );
  return row(r.rows[0]);
}

export async function listReminders(userId: number): Promise<Reminder[]> {
  const r = await query("SELECT * FROM reminders WHERE user_id = $1 AND status = 'active' ORDER BY due_at", [userId]);
  return r.rows.map(row);
}

export async function updateReminder(
  userId: number,
  tz: string,
  id: number,
  patch: { text?: string; localDateTime?: string; rrule?: string | null },
): Promise<Reminder> {
  const sets: string[] = [];
  const vals: unknown[] = [id, userId];
  if (patch.text) {
    vals.push(encrypt(patch.text));
    sets.push(`text_enc = $${vals.length}`);
  }
  if (patch.localDateTime) {
    const due = localToUtc(patch.localDateTime, tz);
    if (!due) throw new DomainError("invalid_datetime", "Data/hora inválida.");
    if (due.toMillis() < Date.now() - 30_000) throw new DomainError("past_datetime", "Esse horário já passou.");
    vals.push(due.toJSDate());
    sets.push(`due_at = $${vals.length}`, "attempts = 0", "next_attempt_at = NULL");
  }
  if (patch.rrule !== undefined) {
    if (patch.rrule && !parseRrule(patch.rrule)) throw new DomainError("invalid_rrule", "Recorrência não suportada.");
    vals.push(patch.rrule);
    sets.push(`rrule = $${vals.length}`);
  }
  if (!sets.length) throw new DomainError("nothing_to_update", "Nada para alterar.");
  // segregação (RNF-13): toda query filtra por user_id
  const r = await query(
    `UPDATE reminders SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING *`,
    vals,
  );
  if (!r.rows[0]) throw new DomainError("not_found", "Lembrete não encontrado.");
  return row(r.rows[0]);
}

export async function cancelReminder(userId: number, id: number): Promise<Reminder> {
  const r = await query(
    "UPDATE reminders SET status = 'cancelled', updated_at = now() WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING *",
    [id, userId],
  );
  if (!r.rows[0]) throw new DomainError("not_found", "Lembrete não encontrado.");
  return row(r.rows[0]);
}

export async function getReminder(userId: number, id: number): Promise<Reminder | null> {
  const r = await query("SELECT * FROM reminders WHERE id = $1 AND user_id = $2 AND status = 'active'", [id, userId]);
  return r.rows[0] ? row(r.rows[0]) : null;
}
