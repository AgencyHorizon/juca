import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().default("postgres://juca:juca@localhost:5432/juca"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  DATA_ENCRYPTION_KEY: z.string().default(""),
  ADMIN_TOKEN: z.string().default(""),

  JUCA_MODEL: z.string().default("claude-haiku-5-5"),
  JUCA_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  PROMPT_VERSION: z.string().default("v1"),

  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),

  WHATSAPP_TOKEN: z.string().default(""),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(""),
  WHATSAPP_APP_SECRET: z.string().default(""),
  WHATSAPP_VERIFY_TOKEN: z.string().default(""),

  // Transcrição de voz (RF-07): NVIDIA NIM (Riva gRPC) + Hugging Face como reserva
  NVIDIA_API_KEY: z.string().default(""),
  NVIDIA_ASR_FUNCTION_ID: z.string().default("b702f636-f60c-4a3d-a6f4-f3568c13bd7d"), // whisper-large-v3
  HF_TOKEN: z.string().default(""),
  HF_ASR_MODEL: z.string().default("openai/whisper-large-v3"),
  STT_LANGUAGE: z.string().default("pt"),

  RATE_LIMIT_PER_HOUR: z.coerce.number().default(60),
  MAX_ACTIVE_REMINDERS: z.coerce.number().default(20),
  SESSION_TIMEOUT_HOURS: z.coerce.number().default(24),
  LOG_RETENTION_DAYS: z.coerce.number().default(90),
  BETA_USER_CAP: z.coerce.number().default(1000),
});

export const config = Env.parse(process.env);
export type Config = typeof config;

export const TERMS_VERSION = "2026-10-31";
export const DEFAULT_TIMEZONE = "America/Sao_Paulo";
