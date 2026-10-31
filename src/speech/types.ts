/** Transcrição de áudio (RF-07). Implementações: NVIDIA NIM (Riva gRPC) e Hugging Face. */
export interface Transcriber {
  readonly name: string;
  transcribe(audio: Buffer, mimeType: string, opts?: { language?: string }): Promise<string>;
}

/** Áudios de voz do WhatsApp/Telegram chegam como OGG/Opus. */
export function isOggOpus(mimeType: string): boolean {
  return /ogg|opus/i.test(mimeType);
}
