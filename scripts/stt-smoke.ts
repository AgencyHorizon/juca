/**
 * Teste rápido dos provedores de transcrição com um arquivo de áudio real.
 *   npx tsx --env-file=.env scripts/stt-smoke.ts caminho/para/audio.ogg
 */
import { readFileSync } from "node:fs";
import { HuggingFaceTranscriber } from "../src/speech/huggingface.js";
import { NvidiaRivaTranscriber } from "../src/speech/nvidia.js";
import type { Transcriber } from "../src/speech/types.js";

const file = process.argv[2];
if (!file) {
  console.error("uso: scripts/stt-smoke.ts <arquivo .ogg|.wav>");
  process.exit(1);
}
const audio = readFileSync(file);
const mime = file.endsWith(".wav") ? "audio/wav" : "audio/ogg; codecs=opus";

const providers: Transcriber[] = [];
if (process.env.NVIDIA_API_KEY) providers.push(new NvidiaRivaTranscriber(process.env.NVIDIA_API_KEY));
if (process.env.HF_TOKEN) providers.push(new HuggingFaceTranscriber(process.env.HF_TOKEN));

for (const p of providers) {
  const t0 = Date.now();
  try {
    const text = await p.transcribe(audio, mime, { language: process.env.STT_LANGUAGE ?? "pt" });
    console.log(`${p.name} (${Date.now() - t0}ms): ${JSON.stringify(text)}`);
  } catch (e) {
    console.log(`${p.name} ERRO (${Date.now() - t0}ms): ${(e as Error).message.slice(0, 300)}`);
  }
}
process.exit(0);
