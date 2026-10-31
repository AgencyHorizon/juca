-- Integrações com contas externas (e-mail; base para calendário depois).
-- Tokens OAuth ficam cifrados (AES-256-GCM) pela aplicação e nunca passam pelo modelo nem pelo chat.

CREATE TABLE IF NOT EXISTS connections (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('google')),
  account_email     TEXT NOT NULL,
  scopes            TEXT NOT NULL,
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- Estado do fluxo OAuth (anti-CSRF + PKCE). Expira em 15 min; uso único.
CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL
);
