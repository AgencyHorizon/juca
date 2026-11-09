-- Conectores estilo Grok Bot: Outlook, bancos (Open Finance), rotinas e janela de 24h do WhatsApp.

ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_provider_check;
ALTER TABLE connections ADD CONSTRAINT connections_provider_check CHECK (provider IN ('google', 'microsoft'));

-- Bancos conectados via Pluggy (Open Finance). Guardamos só o vínculo: saldos e extratos são lidos na hora.
CREATE TABLE IF NOT EXISTS bank_items (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id        TEXT NOT NULL,
  connector_name TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, item_id)
);

-- Rotina = lembrete cujo texto é uma instrução executada pelo agente na hora marcada.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS is_routine BOOLEAN NOT NULL DEFAULT FALSE;

-- Janela de atendimento de 24h do WhatsApp e canal mais recente para mensagens proativas.
ALTER TABLE channel_identities ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;
