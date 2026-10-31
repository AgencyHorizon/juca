import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

// RNF-09: AES-256-GCM em repouso. Formato: v1:<iv b64>:<tag b64>:<ciphertext b64>
let key: Buffer | null = null;
function getKey(): Buffer {
  if (key) return key;
  if (!config.DATA_ENCRYPTION_KEY) {
    if (config.NODE_ENV === "production") throw new Error("DATA_ENCRYPTION_KEY obrigatório em produção");
    key = createHash("sha256").update("juca-dev-only-key").digest();
  } else {
    key = Buffer.from(config.DATA_ENCRYPTION_KEY, "base64");
    if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY deve ter 32 bytes (base64)");
  }
  return key;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(payload: string): string {
  const [v, iv, tag, ct] = payload.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("payload cifrado inválido");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
