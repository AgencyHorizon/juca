import { Worker } from "bullmq";
import type { InboundMessage } from "./channels/types.js";
import { handleInbound } from "./core/handler.js";
import { INBOUND_QUEUE } from "./jobs/queue.js";
import { dispatchDueReminders } from "./jobs/reminders.js";
import { runRetention } from "./jobs/retention.js";
import { logger } from "./lib/logger.js";
import { errors } from "./lib/metrics.js";
import { redis } from "./lib/redis.js";

/**
 * Processo de background. Pode rodar N réplicas (RNF-06):
 *  - consome a fila de mensagens recebidas (concorrência por réplica)
 *  - dispara lembretes vencidos a cada 10s (SKIP LOCKED evita duplicidade entre réplicas)
 *  - executa a retenção de dados a cada hora
 */
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 50);

// Mensagens do mesmo usuário são serializadas com um lock curto no Redis para preservar a ordem da conversa.
async function withUserLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = `lock:${key}`;
  for (let i = 0; i < 300; i++) {
    if (await redis.set(lockKey, "1", "PX", 120_000, "NX")) {
      try {
        return await fn();
      } finally {
        await redis.del(lockKey);
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timeout aguardando lock do usuário");
}

const worker = new Worker<InboundMessage>(
  INBOUND_QUEUE,
  async (job) => withUserLock(`${job.data.channel}:${job.data.externalUserId}`, () => handleInbound(job.data)),
  { connection: redis, concurrency: CONCURRENCY },
);
worker.on("failed", (job, err) => {
  errors.inc({ where: "inbound_job" });
  logger.error({ err, jobId: job?.id }, "job de mensagem falhou");
});

let stopping = false;
async function loop(name: string, everyMs: number, fn: () => Promise<unknown>) {
  while (!stopping) {
    try {
      await fn();
    } catch (e) {
      errors.inc({ where: name });
      logger.error({ err: e }, `${name} falhou`);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

void loop("reminders", 10_000, dispatchDueReminders);
void loop("retention", 3600_000, runRetention);

async function shutdown() {
  stopping = true;
  await worker.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
logger.info({ concurrency: CONCURRENCY }, "worker do Juca iniciado");
