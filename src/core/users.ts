import { query, tx } from "../db/pool.js";
import type { ChannelName } from "../channels/types.js";

export interface User {
  id: number;
  phone: string | null;
  name: string | null;
  timezone: string;
  language: string;
  status: "onboarding" | "active" | "paused" | "blocked" | "deleted";
  onboarding_step: string;
  otp_hash: string | null;
  otp_expires_at: Date | null;
  otp_attempts: number;
  phone_verified: boolean;
  terms_accepted_at: Date | null;
  training_consent: boolean;
  is_adult: boolean | null;
  cohort: string;
  abuse_strikes: number;
  pending_action: PendingAction | null;
  created_at: Date;
  last_seen_at: Date;
}

/** RF-18: ação irreversível aguardando "sim". Ligada ao texto exato que foi mostrado ao usuário. */
export interface PendingAction {
  kind: "delete_all_data" | "cancel_reminder" | "clear_list" | "forget_fact" | "send_email" | "disconnect_account" | "calendar_create" | "calendar_delete";
  args: Record<string, unknown>;
  prompt: string;
  expiresAt: string;
}

export interface Identity {
  user: User;
  channel: ChannelName;
  externalUserId: string;
}

/** RF-01: cria o perfil automaticamente na primeira mensagem. */
export async function findOrCreateByChannel(channel: ChannelName, externalUserId: string): Promise<{ user: User; created: boolean }> {
  const found = await query<User>(
    `SELECT u.* FROM users u JOIN channel_identities ci ON ci.user_id = u.id
     WHERE ci.channel = $1 AND ci.external_id = $2`,
    [channel, externalUserId],
  );
  if (found.rows[0]) return { user: found.rows[0], created: false };

  return tx(async (c) => {
    const u = await c.query<User>("INSERT INTO users DEFAULT VALUES RETURNING *");
    const user = u.rows[0]!;
    await c.query("INSERT INTO channel_identities(user_id, channel, external_id) VALUES ($1,$2,$3)", [user.id, channel, externalUserId]);
    return { user, created: true };
  });
}

export async function getUser(id: number): Promise<User | null> {
  const r = await query<User>("SELECT * FROM users WHERE id = $1", [id]);
  return r.rows[0] ?? null;
}

const UPDATABLE = new Set([
  "phone", "name", "timezone", "language", "status", "onboarding_step", "otp_hash", "otp_expires_at",
  "otp_attempts", "phone_verified", "terms_version", "terms_accepted_at", "training_consent", "is_adult",
  "cohort", "abuse_strikes", "pending_action", "last_seen_at",
]);

export async function updateUser(id: number, patch: Record<string, unknown>): Promise<User> {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (!keys.length) return (await getUser(id))!;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const values = keys.map((k) => {
    const v = patch[k];
    return k === "pending_action" && v !== null ? JSON.stringify(v) : v;
  });
  const r = await query<User>(`UPDATE users SET ${sets} WHERE id = $1 RETURNING *`, [id, ...values]);
  return r.rows[0]!;
}

/** Registra a última mensagem recebida no canal (janela de 24h do WhatsApp e canal preferido para avisos). */
export async function touchChannel(userId: number, channel: ChannelName, externalId: string) {
  await query("UPDATE channel_identities SET last_inbound_at = now() WHERE user_id = $1 AND channel = $2 AND external_id = $3", [userId, channel, externalId]);
}

export async function channelsOf(userId: number): Promise<{ channel: ChannelName; external_id: string }[]> {
  const r = await query("SELECT channel, external_id FROM channel_identities WHERE user_id = $1 ORDER BY id", [userId]);
  return r.rows;
}

export async function countActiveUsers(): Promise<number> {
  const r = await query<{ n: string }>("SELECT count(*) n FROM users WHERE status IN ('onboarding','active','paused')");
  return Number(r.rows[0]!.n);
}

/**
 * RN-01 + RN-04: se o telefone verificado já pertence a outro usuário, este canal é
 * vinculado à conta existente (máx. 2 canais) e o perfil provisório é descartado.
 */
export async function mergeIntoExistingByPhone(provisional: User, phone: string): Promise<{ user: User; merged: boolean; tooManyChannels?: boolean }> {
  const existing = await query<User>("SELECT * FROM users WHERE phone = $1 AND id <> $2", [phone, provisional.id]);
  const target = existing.rows[0];
  if (!target) return { user: provisional, merged: false };
  const chans = await channelsOf(target.id);
  if (chans.length >= 2) return { user: provisional, merged: false, tooManyChannels: true };
  await tx(async (c) => {
    await c.query("UPDATE channel_identities SET user_id = $1 WHERE user_id = $2", [target.id, provisional.id]);
    await c.query("DELETE FROM users WHERE id = $1", [provisional.id]);
  });
  return { user: target, merged: true };
}
