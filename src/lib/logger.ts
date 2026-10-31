import pino from "pino";
import { AsyncLocalStorage } from "node:async_hooks";

// RNF-27: logs JSON estruturados com correlation ID por conversa
export const correlation = new AsyncLocalStorage<{ correlationId: string; userId?: number }>();

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "juca" },
  mixin() {
    return correlation.getStore() ?? {};
  },
  redact: ["*.text", "*.content", "*.phone", "req.headers.authorization"],
});
