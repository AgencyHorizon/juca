import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { audit } from "../core/audit.js";
import { query } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";

/**
 * OAuth 2.0 (código + PKCE + state de uso único) para Google e Microsoft.
 * Tokens ficam cifrados e nunca passam pelo modelo nem pelo chat.
 */
export type OAuthProvider = "google" | "microsoft";

const GOOGLE_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  GOOGLE_READONLY,
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
];
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const MICROSOFT_SCOPES = ["openid", "email", "offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"];

const PROVIDERS = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: GOOGLE_SCOPES,
    extra: { access_type: "offline", prompt: "consent" } as Record<string, string>,
    clientId: () => config.GOOGLE_CLIENT_ID,
    clientSecret: () => config.GOOGLE_CLIENT_SECRET,
  },
  microsoft: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: MICROSOFT_SCOPES,
    extra: { response_mode: "query", prompt: "select_account" } as Record<string, string>,
    clientId: () => config.MICROSOFT_CLIENT_ID,
    clientSecret: () => config.MICROSOFT_CLIENT_SECRET,
  },
};

export const redirectUri = (p: OAuthProvider) => `${config.PUBLIC_BASE_URL}/oauth/${p}/callback`;
export const providerConfigured = (p: OAuthProvider) => !!(PROVIDERS[p].clientId() && PROVIDERS[p].clientSecret());
export const googleConfigured = () => providerConfigured("google");

export class NotConnectedError extends Error {
  constructor(public provider: OAuthProvider) {
    super(`${provider} não conectado`);
  }
}

const b64url = (b: Buffer) => b.toString("base64url");

/** Link de conexão (15 min, uso único). Um link novo invalida os anteriores do mesmo provedor. */
export async function createAuthLink(userId: number, provider: OAuthProvider): Promise<string> {
  const p = PROVIDERS[provider];
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  await query("DELETE FROM oauth_states WHERE (user_id = $1 AND provider = $2) OR expires_at < now()", [userId, provider]);
  await query("INSERT INTO oauth_states(state, user_id, provider, code_verifier, expires_at) VALUES ($1,$2,$3,$4, now() + interval '15 minutes')", [
    state,
    userId,
    provider,
    verifier,
  ]);
  const url = new URL(p.authUrl);
  url.search = new URLSearchParams({
    client_id: p.clientId(),
    redirect_uri: redirectUri(provider),
    response_type: "code",
    scope: p.scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...p.extra,
  }).toString();
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

async function tokenRequest(provider: OAuthProvider, params: Record<string, string>): Promise<TokenResponse> {
  const p = PROVIDERS[provider];
  const res = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: p.clientId(), client_secret: p.clientSecret(), ...params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${provider} token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as TokenResponse;
}

async function accountEmail(provider: OAuthProvider, accessToken: string): Promise<string | undefined> {
  const headers = { authorization: `Bearer ${accessToken}` };
  if (provider === "google") {
    const r = (await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers })).json()) as { email?: string };
    return r.email;
  }
  const r = (await (await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers })).json()) as {
    mail?: string;
    userPrincipalName?: string;
  };
  return r.mail ?? r.userPrincipalName;
}

export async function handleCallback(provider: OAuthProvider, state: string, code: string): Promise<{ userId: number; email: string }> {
  const st = await query<{ user_id: number; code_verifier: string }>(
    "DELETE FROM oauth_states WHERE state = $1 AND provider = $2 AND expires_at > now() RETURNING user_id, code_verifier",
    [state, provider],
  );
  const row = st.rows[0];
  if (!row) throw new Error("state inválido ou expirado");

  const tok = await tokenRequest(provider, { grant_type: "authorization_code", code, redirect_uri: redirectUri(provider), code_verifier: row.code_verifier });
  const scopes = tok.scope ?? PROVIDERS[provider].scopes.join(" ");
  if (provider === "google" && !scopes.split(" ").includes(GOOGLE_READONLY)) throw new Error("permissão de leitura de e-mail não concedida");
  const email = await accountEmail(provider, tok.access_token);
  if (!email) throw new Error("não foi possível identificar a conta");

  await query(
    `INSERT INTO connections(user_id, provider, account_email, scopes, access_token_enc, refresh_token_enc, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)
     ON CONFLICT (user_id, provider) DO UPDATE SET account_email = EXCLUDED.account_email, scopes = EXCLUDED.scopes,
       access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, connections.refresh_token_enc),
       expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [row.user_id, provider, email, scopes, encrypt(tok.access_token), tok.refresh_token ? encrypt(tok.refresh_token) : null, String(tok.expires_in - 60)],
  );
  await audit(row.user_id, "user", "account_connected", { provider });
  return { userId: row.user_id, email };
}

export interface Connection {
  provider: OAuthProvider;
  account_email: string;
  scopes: string;
  created_at: Date;
}

export async function listConnections(userId: number): Promise<Connection[]> {
  const r = await query<Connection>("SELECT provider, account_email, scopes, created_at FROM connections WHERE user_id = $1 ORDER BY id", [userId]);
  return r.rows;
}

export async function getAccessToken(userId: number, provider: OAuthProvider): Promise<string> {
  const r = await query<{ access_token_enc: string; refresh_token_enc: string | null; expires_at: Date }>(
    "SELECT access_token_enc, refresh_token_enc, expires_at FROM connections WHERE user_id = $1 AND provider = $2",
    [userId, provider],
  );
  const c = r.rows[0];
  if (!c) throw new NotConnectedError(provider);
  if (new Date(c.expires_at).getTime() > Date.now()) return decrypt(c.access_token_enc);
  if (!c.refresh_token_enc) throw new NotConnectedError(provider);
  try {
    const tok = await tokenRequest(provider, { grant_type: "refresh_token", refresh_token: decrypt(c.refresh_token_enc) });
    await query(
      `UPDATE connections SET access_token_enc = $3, refresh_token_enc = COALESCE($4, refresh_token_enc),
         expires_at = now() + ($5 || ' seconds')::interval, updated_at = now() WHERE user_id = $1 AND provider = $2`,
      [userId, provider, encrypt(tok.access_token), tok.refresh_token ? encrypt(tok.refresh_token) : null, String(tok.expires_in - 60)],
    );
    return tok.access_token;
  } catch (e) {
    if (/invalid_grant/.test(String((e as Error).message))) {
      await query("DELETE FROM connections WHERE user_id = $1 AND provider = $2", [userId, provider]);
      await audit(userId, "system", "account_connection_expired", { provider });
      throw new NotConnectedError(provider);
    }
    throw e;
  }
}

/**
 * Desconecta e apaga os tokens. O Google tem revogação por token; a Microsoft não documenta revogação de
 * um único refresh token, então lá o acesso só some de vez quando a pessoa remove o app na conta dela.
 */
export async function disconnect(userId: number, provider: OAuthProvider): Promise<boolean> {
  const r = await query<{ access_token_enc: string; refresh_token_enc: string | null }>(
    "DELETE FROM connections WHERE user_id = $1 AND provider = $2 RETURNING access_token_enc, refresh_token_enc",
    [userId, provider],
  );
  const c = r.rows[0];
  if (!c) return false;
  if (provider === "google") {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: decrypt(c.refresh_token_enc ?? c.access_token_enc) }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
  await audit(userId, "user", "account_disconnected", { provider });
  return true;
}

export async function disconnectAll(userId: number) {
  for (const c of await listConnections(userId)) await disconnect(userId, c.provider).catch(() => {});
}
