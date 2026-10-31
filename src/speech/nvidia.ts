import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { isOggOpus, type Transcriber } from "./types.js";

/**
 * NVIDIA NIM hospedado (build.nvidia.com) — os modelos de fala são servidos pela API gRPC do Riva
 * em grpc.nvcf.nvidia.com, roteados pelo header `function-id` de cada modelo.
 * Protos oficiais: github.com/nvidia-riva/common (copiados em /proto).
 */
export const NVIDIA_ASR_FUNCTIONS = {
  "whisper-large-v3": "b702f636-f60c-4a3d-a6f4-f3568c13bd7d", // multilíngue (inclui pt), offline
  "canary-1b-asr": "b0e8b4a5-217c-40b7-9b96-17d84e666317",
  "parakeet-1_1b-rnnt-multilingual-asr": "71203149-d3b7-4460-8231-1be2543a1fca",
} as const;

const PROTO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../proto/riva");

let RivaASR: grpc.ServiceClientConstructor | null = null;
function loadService(): grpc.ServiceClientConstructor {
  if (RivaASR) return RivaASR;
  const def = protoLoader.loadSync(path.join(PROTO_ROOT, "proto/riva_asr.proto"), {
    includeDirs: [PROTO_ROOT, path.dirname(PROTO_ROOT)],
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as any;
  RivaASR = pkg.nvidia.riva.asr.RivaSpeechRecognition as grpc.ServiceClientConstructor;
  return RivaASR;
}

/** Lê taxa de amostragem e canais de um WAV PCM (RIFF). */
export function parseWavHeader(buf: Buffer): { sampleRate: number; channels: number } | null {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  // percorre os chunks até achar "fmt "
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") return { channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12) };
    off += 8 + size + (size % 2);
  }
  return null;
}

interface RecognizeResponse {
  results: { alternatives: { transcript: string; confidence: number }[] }[];
}

export class NvidiaRivaTranscriber implements Transcriber {
  readonly name: string;
  private client: grpc.Client & Record<string, any>;

  constructor(
    private apiKey: string,
    private functionId: string = NVIDIA_ASR_FUNCTIONS["whisper-large-v3"],
    private server = "grpc.nvcf.nvidia.com:443",
    private timeoutMs = 30_000,
  ) {
    this.name = `nvidia:${functionId.slice(0, 8)}`;
    const Svc = loadService();
    this.client = new Svc(this.server, grpc.credentials.createSsl()) as any;
  }

  transcribe(audio: Buffer, mimeType: string, opts?: { language?: string }): Promise<string> {
    const md = new grpc.Metadata();
    md.set("function-id", this.functionId);
    md.set("authorization", `Bearer ${this.apiKey}`);
    const ogg = isOggOpus(mimeType);
    const wav = ogg ? null : parseWavHeader(audio);
    if (!ogg && !wav) return Promise.reject(new Error("nvidia asr: formato de áudio não suportado (use OGG/Opus ou WAV PCM)"));
    const config = {
      // OGG/Opus é decodificado pelo servidor; WAV precisa informar a taxa e os canais do cabeçalho
      encoding: ogg ? "OGGOPUS" : "LINEAR_PCM",
      sample_rate_hertz: wav?.sampleRate ?? 0,
      audio_channel_count: wav?.channels ?? 1,
      language_code: opts?.language ?? "pt",
      max_alternatives: 1,
      enable_automatic_punctuation: true,
    };
    return new Promise((resolve, reject) => {
      this.client.Recognize(
        { config, audio },
        md,
        { deadline: Date.now() + this.timeoutMs },
        (err: grpc.ServiceError | null, res: RecognizeResponse) => {
          if (err) return reject(new Error(`nvidia asr: ${err.code} ${err.details}`));
          resolve(
            res.results
              .map((r) => r.alternatives[0]?.transcript ?? "")
              .join(" ")
              .replace(/\s+/g, " ")
              .trim(),
          );
        },
      );
    });
  }
}
