import type { Transcriber } from "./types.js";

/**
 * Hugging Face Inference Providers — tarefa automatic-speech-recognition.
 * Recebe o áudio cru no corpo e devolve { text }.
 */
export class HuggingFaceTranscriber implements Transcriber {
  readonly name: string;

  constructor(
    private token: string,
    private model = "openai/whisper-large-v3",
    private baseUrl = "https://router.huggingface.co/hf-inference/models",
    private timeoutMs = 30_000,
  ) {
    this.name = `hf:${model}`;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/${this.model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": mimeType.split(";")[0]!.trim() },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`hf asr ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { text?: string };
    return (data.text ?? "").trim();
  }
}
