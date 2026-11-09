import { randomInt } from "node:crypto";
import { config } from "../config.js";
import { query } from "../db/pool.js";
import { audit } from "./audit.js";
import { DomainError } from "./reminders.js";
import type { User } from "./users.js";

/** Acesso por convite: quem entra tem um código de alguém de dentro, ou fica na lista de espera. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateCode(): string {
  return "JUCA-" + Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

export function parseInviteCode(text: string): string | null {
  return text.match(/JUCA-[A-Z0-9]{6}/i)?.[0]?.toUpperCase() ?? null;
}

export const inviteLink = (code: string) => (config.TELEGRAM_BOT_USERNAME ? `https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${code}` : null);

export async function createInvite(createdBy: number | null): Promise<string> {
  const code = generateCode();
  await query("INSERT INTO invites(code, created_by) VALUES ($1,$2)", [code, createdBy]);
  return code;
}

/** Uso único, atômico: dois cadastros simultâneos não conseguem usar o mesmo código. */
export async function claimInvite(code: string, userId: number): Promise<boolean> {
  const r = await query("UPDATE invites SET used_by = $2, used_at = now() WHERE code = $1 AND used_by IS NULL RETURNING created_by", [code, userId]);
  if (!r.rowCount) return false;
  await query("UPDATE users SET invite_accepted = TRUE WHERE id = $1", [userId]);
  await audit(userId, "user", "invite_accepted", { invited_by: r.rows[0].created_by ?? "admin" });
  return true;
}

/** A pessoa gera um convite do próprio saldo. Decremento atômico: não dá para passar do limite. */
export async function issueInvite(user: User): Promise<{ code: string; link: string | null; left: number }> {
  const r = await query<{ invites_left: number }>("UPDATE users SET invites_left = invites_left - 1 WHERE id = $1 AND invites_left > 0 RETURNING invites_left", [user.id]);
  if (!r.rowCount) throw new DomainError("no_invites", "Você não tem mais convites disponíveis.");
  const code = await createInvite(user.id);
  await audit(user.id, "user", "invite_created");
  return { code, link: inviteLink(code), left: r.rows[0]!.invites_left };
}

/** Número já cadastrado vinculando outro canal não precisa de convite novo. */
export async function phoneHasAccount(phone: string, exceptUserId: number): Promise<boolean> {
  const r = await query("SELECT 1 FROM users WHERE phone = $1 AND id <> $2 AND invite_accepted", [phone, exceptUserId]);
  return !!r.rowCount;
}
