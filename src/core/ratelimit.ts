import { config } from "../config.js";
import { redis } from "../lib/redis.js";

/**
 * RN-11 / RNF-11: janela deslizante de 1h por usuário.
 * Retorna se a mensagem pode seguir e se é a primeira vez que estourou (para avisar só uma vez).
 */
export async function checkRateLimit(userId: number): Promise<{ allowed: boolean; firstBlock: boolean }> {
  const key = `rl:${userId}`;
  const now = Date.now();
  const windowStart = now - 3600_000;
  const res = await redis
    .multi()
    .zremrangebyscore(key, 0, windowStart)
    .zadd(key, now, `${now}-${Math.random()}`)
    .zcard(key)
    .expire(key, 3600)
    .exec();
  const count = Number(res?.[2]?.[1] ?? 0);
  if (count <= config.RATE_LIMIT_PER_HOUR) return { allowed: true, firstBlock: false };
  const warned = await redis.set(`rlw:${userId}`, "1", "EX", 3600, "NX");
  return { allowed: false, firstBlock: warned === "OK" };
}
