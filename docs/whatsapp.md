# WhatsApp: adapter da API da Meta

O adapter (`src/channels/whatsapp.ts`) usa a WhatsApp Cloud API. Basta inserir os dados da sua conta no `.env`.

## 1. Dados para inserir

Em [developers.facebook.com](https://developers.facebook.com/apps), no seu app com o produto WhatsApp:

| Variável | Onde achar |
|---|---|
| `WHATSAPP_TOKEN` | Token de **usuário do sistema** (Configurações do negócio → Usuários do sistema), com `whatsapp_business_messaging` e `whatsapp_business_management`. O token temporário do painel expira em 24h |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → Configuração da API → "Identificação do número de telefone" (não é o número) |
| `WHATSAPP_APP_SECRET` | Configurações do app → Básico → Chave secreta |
| `WHATSAPP_VERIFY_TOKEN` | Uma senha que você inventa e repete no passo 3 |
| `PUBLIC_BASE_URL` | URL pública HTTPS do Juca (deploy ou ngrok) |

## 2. Validar

```bash
npm run whatsapp:check                     # confere token e número
npm run whatsapp:check -- 5511999990000    # também envia o template de teste hello_world
```

## 3. Webhook

Suba o servidor (`npm run dev`) e o worker (`npm run dev:worker`). Em WhatsApp → Configuração:

- **URL de callback:** `{PUBLIC_BASE_URL}/webhooks/whatsapp`
- **Token de verificação:** o mesmo `WHATSAPP_VERIFY_TOKEN`
- **Campo assinado:** `messages`

## 4. Template para lembretes e rotinas (janela de 24h)

A Meta só permite texto livre até 24h depois da última mensagem da pessoa. Depois disso, só template aprovado. Crie um no Gerenciador do WhatsApp:

- Nome: `lembrete_juca` · Categoria: Utilidade · Idioma: Português (BR)
- Corpo: `Seu aviso do Juca: {{1}}`

Depois defina `WHATSAPP_REMINDER_TEMPLATE=lembrete_juca`. Sem isso, o aviso tenta o Telegram, se a pessoa tiver vinculado; se não houver outro canal, ele falha após as tentativas e fica registrado no log.

## O que o adapter faz

- Valida a assinatura `X-Hub-Signature-256` de cada webhook.
- Recebe texto, botões, reações (👍/👎) e áudio (transcrito).
- Marca como lida e mostra "digitando…".
- Usa botões de resposta nas confirmações (Sim/Não).
- Registra falhas de entrega informadas pela Meta (`juca_errors_total{where="whatsapp_status:<código>"}`).
- Imagens e documentos ainda são ignorados.
