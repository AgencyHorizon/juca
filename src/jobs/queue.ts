import { Queue } from "bullmq";
import { redis } from "../lib/redis.js";
import type { InboundMessage } from "../channels/types.js";

// RNF-07: o webhook só enfileira e responde 200 rápido; os workers processam (RNF-06: stateless, escalam na horizontal)
export const INBOUND_QUEUE = "juca-inbound";

export const inboundQueue = new Queue<InboundMessage>(INBOUND_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 }, // RNF-25
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export async function enqueueInbound(msg: InboundMessage) {
  // jobId deduplica reentregas do webhook antes mesmo de chegar no banco (RNF-24)
  const jobId = `${msg.channel}-${msg.externalMessageId}`.replace(/:/g, "_");
  await inboundQueue.add("message", msg, { jobId });
}
