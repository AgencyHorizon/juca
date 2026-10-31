import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { errors } from "../lib/metrics.js";
import { HuggingFaceTranscriber } from "./huggingface.js";
import { NvidiaRivaTranscriber } from "./nvidia.js";
import type { Transcriber } from "./types.js";

/** Tenta os provedores em ordem; o primeiro que devolver texto vence (RNF-25: resiliência). */
export class FallbackTranscriber implements Transcriber {
  readonly name: string;
  constructor(private providers: Transcriber[]) {
    this.name = providers.map((p) => p.name).join(" → ");
  }
  async transcribe(audio: Buffer, mimeType: string, opts?: { language?: string }): Promise<string> {
    let lastErr: unknown;
    for (const p of this.providers) {
      try {
        const text = await p.transcribe(audio, mimeType, opts);
        if (text) return text;
      } catch (e) {
        lastErr = e;
        errors.inc({ where: `stt:${p.name}` });
        logger.warn({ err: e, provider: p.name }, "provedor de transcrição falhou, tentando o próximo");
      }
    }
    if (lastErr) throw lastErr;
    return "";
  }
}

/** Monta a cadeia a partir do ambiente: NVIDIA NIM primeiro, Hugging Face como reserva. */
export function transcriberFromEnv(): Transcriber | null {
  const providers: Transcriber[] = [];
  if (config.NVIDIA_API_KEY) providers.push(new NvidiaRivaTranscriber(config.NVIDIA_API_KEY, config.NVIDIA_ASR_FUNCTION_ID));
  if (config.HF_TOKEN) providers.push(new HuggingFaceTranscriber(config.HF_TOKEN, config.HF_ASR_MODEL));
  return providers.length ? new FallbackTranscriber(providers) : null;
}

export type { Transcriber } from "./types.js";
