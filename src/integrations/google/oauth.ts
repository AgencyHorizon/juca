import { createHash, randomBytes } from "node:crypto";
import { config } from "../../config.js";
import { audit } from "../../core/audit.js";
import { query } from "../../db/pool.js";
import { decrypt, encrypt } from "../../lib/crypto.js";

/**
 * OAuth 2.0 do Google (fluxo de servidor web + PKCE + state anti-CSRF).
 * Escopos mínimos: ler e-mails e criar/enviar rascunhos. Nada de calendário/drive por enquanto.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose", // criar rascunhos e enviar (envio só com confirmação + flag)
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const redirectUri = () => `${config.PUBLIC_BASE_URL}/oauth/google/callback`;
export const googleConfigured = () => !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);

const b64url = (b: Buffer) => b.toString("base64url");

export class NotConnectedError extends Error {
  constructor() {
    super("e-mail não conectado");
  }
}

/** Gera o link de conexão (válido por 15 min, uso único). */
export async function createAuthLink(userId: number): Promise<string> {
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  await query("DELETE FROM oauth_states WHERE user_id = $1 OR expires_at < now()", [userId]);
  await query(
    "INSERT INTO oauth_states(state, user_id, provider, code_verifier, expires_at) VALUES ($1,$2,'google',$3, now() + interval '15 minutes')",
    [state, userId, verifier],
  );
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline", // refresh token
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID, client_secret: config.GOOGLE_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`google token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as TokenResponse;
}

/** Callback do OAuth: valida state, troca o code, guarda tokens cifrados. Retorna o usuário e o e-mail conectado. */
export async function handleCallback(state: string, code: string): Promise<{ userId: number; email: string }> {
  const st = await query<{ user_id: number; code_verifier: string }>(
    "DELETE FROM oauth_states WHERE state = $1 AND expires_at > now() RETURNING user_id, code_verifier",
    [state],
  );
  const row = st.rows[0];
  if (!row) throw new Error("state inválido ou expirado");

  const tok = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: row.code_verifier });
  const granted = tok.scope.split(" ");
  if (!granted.includes("https://www.googleapis.com/auth/gmail.readonly")) throw new Error("permissão de leitura de e-mail não concedida");

  const info = (await (await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${tok.access_token}` } })).json()) as { email?: string };
  if (!info.email) throw new Error("não foi possível identificar o e-mail");

  await query(
    `INSERT INTO connections(user_id, provider, account_email, scopes, access_token_enc, refresh_token_enc, expires_at)
     VALUES ($1,'google',$2,$3,$4,$5, now() + ($6 || ' seconds')::interval)
     ON CONFLICT (user_id, provider) DO UPDATE SET account_email = EXCLUDED.account_email, scopes = EXCLUDED.scopes,
       access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, connections.refresh_token_enc),
       expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [row.user_id, info.email, tok.scope, encrypt(tok.access_token), tok.refresh_token ? encrypt(tok.refresh_token) : null, String(tok.expires_in - 60)],
  );
  await audit(row.user_id, "user", "email_connected", { provider: "google", scopes: granted.length });
  return { userId: row.user_id, email: info.email };
}

export async function getConnection(userId: number) {
  const r = await query<{ account_email: string; scopes: string; created_at: Date }>(
    "SELECT account_email, scopes, created_at FROM connections WHERE user_id = $1 AND provider = 'google'",
    [userId],
  );
  return r.rows[0] ?? null;
}

/** Access token válido (renova com o refresh token quando expira). */
export async function getAccessToken(userId: number): Promise<string> {
  const r = await query<{ access_token_enc: string; refresh_token_enc: string | null; expires_at: Date }>(
    "SELECT access_token_enc, refresh_token_enc, expires_at FROM connections WHERE user_id = $1 AND provider = 'google'",
    [userId],
  );
  const c = r.rows[0];
  if (!c) throw new NotConnectedError();
  if (new Date(c.expires_at).getTime() > Date.now()) return decrypt(c.access_token_enc);
  if (!c.refresh_token_enc) throw new NotConnectedError();
  try {
    const tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: decrypt(c.refresh_token_enc) });
    await query(
      "UPDATE connections SET access_token_enc = $2, expires_at = now() + ($3 || ' seconds')::interval, updated_at = now() WHERE user_id = $1 AND provider = 'google'",
      [userId, encrypt(tok.access_token), String(tok.expires_in - 60)],
    );
    return tok.access_token;
  } catch (e) {
    // refresh revogado pelo usuário no Google: remove a conexão para não ficar com dado morto
    if (/invalid_grant/.test(String((e as Error).message))) {
      await query("DELETE FROM connections WHERE user_id = $1 AND provider = 'google'", [userId]);
      await audit(userId, "system", "email_connection_expired");
      throw new NotConnectedError();
    }
    throw e;
  }
}

/** Desconecta: revoga no Google e apaga os tokens localmente (lição da Instinct: nada fica retido). */
export async function disconnect(userId: number): Promise<boolean> {
  const r = await query<{ access_token_enc: string; refresh_token_enc: string | null }>(
    "DELETE FROM connections WHERE user_id = $1 AND provider = 'google' RETURNING access_token_enc, refresh_token_enc",
    [userId],
  );
  const c = r.rows[0];
  if (!c) return false;
  const token = decrypt(c.refresh_token_enc ?? c.access_token_enc);
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {}); // a remoção local já aconteceu; revogação é melhor esforço
  await audit(userId, "user", "email_disconnected");
  return true;
}
