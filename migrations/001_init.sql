-- Juca MVP — schema inicial
-- Conteúdo sensível (mensagens, memórias, itens) é gravado cifrado (AES-256-GCM) pela aplicação: colunas *_enc.

CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  phone           TEXT UNIQUE,                       -- RN-01: 1 número = 1 usuário
  name            TEXT,
  timezone        TEXT NOT NULL DEFAULT 'America/Sao_Paulo', -- RN-23
  language        TEXT NOT NULL DEFAULT 'pt-BR',     -- RN-24
  status          TEXT NOT NULL DEFAULT 'onboarding'
                  CHECK (status IN ('onboarding','active','paused','blocked','deleted')),
  onboarding_step TEXT NOT NULL DEFAULT 'start',
  otp_hash        TEXT,
  otp_expires_at  TIMESTAMPTZ,
  otp_attempts    INT NOT NULL DEFAULT 0,
  phone_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  terms_version   TEXT,
  terms_accepted_at TIMESTAMPTZ,
  training_consent BOOLEAN NOT NULL DEFAULT FALSE,   -- RN-17
  is_adult        BOOLEAN,                           -- RN-03 (declaratório)
  cohort          TEXT NOT NULL DEFAULT 'beta',
  abuse_strikes   INT NOT NULL DEFAULT 0,
  pending_action  JSONB,                             -- RF-18: ação aguardando confirmação
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RN-04: até 2 canais por usuário (validado na aplicação)
CREATE TABLE IF NOT EXISTS channel_identities (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('whatsapp','telegram')),
  external_id TEXT NOT NULL,      -- wa_id / telegram chat id
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  BIGINT REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  channel     TEXT NOT NULL,
  content_enc TEXT NOT NULL,
  prompt_version TEXT,
  model       TEXT,
  input_tokens  INT,
  output_tokens INT,
  latency_ms  INT,
  rating      SMALLINT,          -- RF-29: 1 / -1
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS messages_created_idx ON messages(created_at);

-- RNF-24: idempotência de mensagens recebidas
CREATE TABLE IF NOT EXISTS processed_inbound (
  channel     TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, external_message_id)
);

CREATE TABLE IF NOT EXISTS reminders (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text_enc    TEXT NOT NULL,
  due_at      TIMESTAMPTZ NOT NULL,
  rrule       TEXT,              -- RF-24: recorrência (subset: DAILY / WEEKLY;BYDAY=MO,... / MONTHLY)
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','sent','cancelled')),
  attempts    INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(due_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS lists (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS list_items (
  id          BIGSERIAL PRIMARY KEY,
  list_id     BIGINT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  text_enc    TEXT NOT NULL,
  done        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RF-20: memória persistente (fatos declarados)
CREATE TABLE IF NOT EXISTS memories (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value_enc   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

-- RNF-14: log imutável de ações críticas (sem FK: sobrevive à exclusão do usuário, sem PII)
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT,
  actor       TEXT NOT NULL,     -- 'user' | 'agent' | 'admin' | 'system'
  action      TEXT NOT NULL,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log é imutável'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- RF-33: feature flags (global, por coorte ou por usuário)
CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'global',   -- 'global' | 'cohort:<nome>' | 'user:<id>'
  enabled     BOOLEAN NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, scope)
);

-- RN-15: solicitações de exclusão (SLA 72h)
CREATE TABLE IF NOT EXISTS deletion_requests (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
