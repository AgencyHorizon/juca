# Juca

Agente pessoal de IA que **vive onde você já vive**: WhatsApp e Telegram. Não tem app nem dashboard. Você manda mensagem como mandaria para um amigo e o Juca resolve.

Inspirado na Instinct. A pesquisa completa e as decisões tiradas dela estão em [`docs/pesquisa-instinct.md`](docs/pesquisa-instinct.md).

## Arquitetura

```
WhatsApp / Telegram
        │  webhook (assinatura validada)
        ▼
  server (Fastify) ──► fila BullMQ (Redis) ──► worker(s)
                                                 │
                       ┌─────────────────────────┼──────────────────────────┐
                       ▼                         ▼                          ▼
              onboarding determinístico   comandos determinísticos     agente (NVIDIA NIM ou Claude)
              (OTP, termos, nome, fuso)   (pausar, 👍/👎, confirmação)  tool use + clima/links/busca
                                                 │
                                                 ▼
                                   Postgres (dados cifrados AES-256-GCM)
                                                 ▲
                         disparador de lembretes (a cada 10s, SKIP LOCKED) + retenção (1h)
```

- **`src/app.ts`, `src/server.ts`**: servidor HTTP com os webhooks, `/health`, `/metrics` (Prometheus) e `/admin/*` (backoffice).
- **`src/worker.ts`**: consome a fila, com lock por usuário para manter a ordem da conversa. Também dispara lembretes e roda a retenção. Escala horizontalmente.
- **`src/agent/`**: prompt versionado, ferramentas e o loop de tool use. O provedor padrão é a NVIDIA NIM (`nvidia.ts`), com a API da Claude como alternativa. As ferramentas locais de clima, leitura de links e busca ficam em `web.ts`.
- **`src/core/`**: domínio (usuários, onboarding, lembretes, listas, memória, privacidade, flags, rate limit, auditoria).
- **`src/channels/`**: adaptadores e formatação por canal.
- **`src/speech/`**: transcrição de voz. Usa a NVIDIA NIM (`whisper-large-v3` via Riva gRPC) e, se ela falhar, o Hugging Face. Os protos do Riva ficam em `proto/`.
- **`migrations/`**: schema SQL.

## Rodando localmente

```bash
cp .env.example .env          # preencha ANTHROPIC_API_KEY e os tokens dos canais
docker compose up -d          # Postgres + Redis
npm install
npm run migrate
npm run dev                   # servidor (porta 3000)
npm run dev:worker            # worker, em outro terminal
```

**Testar no Telegram sem URL pública:** rode `npm run dev:worker` e, em outro terminal, `npm run dev:telegram`. Esse modo usa long polling e desativa o webhook. Depois é só conversar com o bot.

**Testar o agente sem canal:** `npx tsx --env-file=.env scripts/agent-smoke.ts "me lembra de beber água às 15h"`

**Testar a transcrição com um áudio real:** `npm run stt:smoke -- caminho/audio.ogg`

Para receber webhooks localmente, exponha a porta 3000 (por exemplo com `ngrok http 3000`) e coloque a URL em `PUBLIC_BASE_URL`.

- **Telegram:** crie o bot no @BotFather, defina `TELEGRAM_BOT_TOKEN` e `TELEGRAM_WEBHOOK_SECRET` e registre o webhook com `registerTelegramWebhook()`.
- **WhatsApp Cloud API:** configure o webhook `GET/POST /webhooks/whatsapp` no app da Meta com `WHATSAPP_VERIFY_TOKEN` e `WHATSAPP_APP_SECRET`.

## Testes

```bash
npm test                                   # unitários
INTEGRATION=1 npm test                     # + ponta a ponta (precisa do docker compose rodando e migrado)
```

O teste de integração cobre:

- onboarding completo (IA declarada, OTP, termos, nome, fuso);
- idempotência;
- conversa gravada cifrada;
- lembrete no passado rejeitado e disparo de lembrete recorrente;
- pausar/voltar;
- feedback;
- "apaga tudo" com confirmação.

## Backoffice

Todas as rotas exigem `Authorization: Bearer $ADMIN_TOKEN`.

| Rota | Requisito |
|---|---|
| `GET /admin/metrics/summary` | RF-30: usuários, DAU/WAU, ativação, D7/D30, 👍/👎 por versão de prompt, tokens, latência p50/p95 |
| `GET /admin/users?q=&status=` / `POST /admin/users/:id/block` / `unblock` / `cohort` | RF-31 |
| `GET /admin/users/:id/conversation` | RF-32: só usuários com consentimento; o acesso é auditado |
| `GET /admin/audit` | RNF-14 |
| `GET /admin/flags` / `PUT /admin/flags/:key` `{scope, enabled}` | RF-33: escopo `global`, `cohort:<nome>` ou `user:<id>` |
| `GET /metrics` | RNF-28: Prometheus |

## Rastreabilidade dos requisitos

| Requisito | Onde |
|---|---|
| RF-01..04, RN-01..04, RN-21, RN-25 | `core/onboarding.ts`, `core/users.ts` |
| RF-05/06/08/09 | `channels/*` |
| RF-07 | `speech/*`: NVIDIA NIM `whisper-large-v3` → Hugging Face (reserva), ligado em `handler.ts` (flag `voice_transcription`) |
| RF-10..17, RF-19..24 | `agent/*`, `core/reminders.ts`, `core/lists.ts`, `core/memories.ts`, `core/conversation.ts` |
| RF-18, RN-06 | `pending_action` + confirmação determinística em `handler.ts` |
| RF-25, RNF-23 | `jobs/reminders.ts` (Postgres como fonte da verdade, retry com backoff) |
| RF-26..29, RN-15..19 | `core/privacy.ts`, `handler.ts`, `jobs/retention.ts` |
| RNF-07/24/25 | `jobs/queue.ts`, `processed_inbound`, retries do SDK e da fila |
| RNF-09/10/12/13/14 | `lib/crypto.ts`, verificação de webhooks, `sanitizeInput` + prompt, `user_id` em toda query, trigger imutável no `audit_log` |
| RNF-11, RN-11 | `core/ratelimit.ts` |
| RNF-27/28/30 | `lib/logger.ts` (correlation ID), `lib/metrics.ts`, `agent/prompts.ts` + `prompt_version` gravado em cada resposta |
| RN-12/13/14/23 | `core/reminders.ts`, `core/conversation.ts`, `core/time.ts` |

## Pendências e decisões em aberto

- **Cérebro (LLM):** o padrão é a **NVIDIA NIM** com `nvidia/nemotron-3.5-lightning-30b-a3b` (de 2 a 4 s por resposta nos testes). O `mistralai/mistral-large-4-1t-a52b` é a reserva automática: tem boa qualidade, mas leva de 15 a 35 s. Os dois foram escolhidos num benchmark dos 54 modelos de chat da conta, testando chamada de ferramentas em pt-BR.
  - **Clima:** vem do Open-Meteo, API pública e sem chave.
  - **Busca web geral:** só funciona com `BRAVE_SEARCH_API_KEY`. O Juca não faz scraping de buscadores; sem a chave, ele diz com naturalidade que não consegue pesquisar.
  - **Leitura de links:** busca a página com proteção contra SSRF e revalidação a cada redirecionamento.
- **Alternativa Claude:** `LLM_PROVIDER=anthropic` usa `claude-haiku-5-5` (US$ 0,10 / US$ 0,50 por milhão de tokens), com `effort: low`. Precisa de `ANTHROPIC_API_KEY`: os modelos Claude não rodam na NVIDIA NIM. No Haiku, as ferramentas web usam as variantes básicas (`web_search_20250305` e `web_fetch_20250910`), e o fallback de recusa no servidor não existe.
- **OTP (RF-02):** em desenvolvimento, o código vai pelo próprio canal. Em produção, use `setOtpSender()` com um provedor de SMS, para o código provar a posse do número.
- **Voz (RF-07):** a NVIDIA foi testada com nota de voz real em pt-BR (OGG/Opus e WAV), com resposta em cerca de 1,3 s. No Hugging Face a autenticação funciona, mas a conta está sem créditos de Inference Providers (402).
- **WhatsApp fora da janela de 24h:** lembretes enviados mais de 24h depois da última mensagem do usuário precisam de um *message template* aprovado pela Meta. Ainda falta criar o template e usá-lo em `jobs/reminders.ts`.
- **TLS 1.3 (RNF-08):** fica a cargo do proxy/ingress (o app não termina TLS).
- **DR (RNF-26):** backups com PITR no Postgres gerenciado (RPO ≤ 15 min).
