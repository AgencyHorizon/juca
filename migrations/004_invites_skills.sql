-- Acesso por convite (como a Instinct), skills reutilizáveis e preferências persistentes (como o Grok Bot).

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL, -- NULL = emitido pelo admin
  used_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS invites_created_by_idx ON invites(created_by);

ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_accepted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invites_left INT NOT NULL DEFAULT 3;
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_instructions_enc TEXT;

-- Quem já estava no Juca antes dos convites mantém o acesso.
UPDATE users SET invite_accepted = TRUE WHERE status <> 'onboarding' OR onboarding_step NOT IN ('start', 'waitlist');

CREATE TABLE IF NOT EXISTS skills (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  instructions_enc TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
