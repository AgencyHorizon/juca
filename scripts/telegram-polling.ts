/**
 * Modo de desenvolvimento: recebe mensagens do Telegram por long polling (sem URL pública/ngrok)
 * e coloca na mesma fila que o webhook usa. Rode junto com o worker:
 *   npx tsx --env-file=.env scripts/telegram-polling.ts
 *   npx tsx --env-file=.env src/worker.ts
 * Em produção use o webhook (/webhooks/telegram) — os dois não funcionam ao mesmo tempo.
 */
import { parseTelegram } from "../src/channels/telegram.js";
import { enqueueInbound } from "../src/jobs/queue.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN não definido");
const api = (m: string) => `https://api.telegram.org/bot${token}/${m}`;

const me = (await (await fetch(api("getMe"))).json()) as any;
await fetch(api("deleteWebhook"), { method: "POST" }); // getUpdates não funciona com webhook ativo
console.log(`ouvindo @${me.result.username} por long polling… (Ctrl+C para sair)`);

let offset = 0;
for (;;) {
  try {
    const res = await fetch(api(`getUpdates?timeout=30&offset=${offset}&allowed_updates=["message"]`), {
      signal: AbortSignal.timeout(40_000),
    });
    const data = (await res.json()) as { ok: boolean; result: any[] };
    for (const update of data.result ?? []) {
      offset = update.update_id + 1;
      const msg = parseTelegram(update);
      if (msg) {
        await enqueueInbound(msg);
        console.log(`→ ${msg.externalUserId}: ${msg.text ?? (msg.audio ? "[áudio]" : msg.contactPhone ? "[contato]" : "")}`);
      }
    }
  } catch (e) {
    console.error("erro no polling, tentando de novo em 3s:", (e as Error).message);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
