import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

// config é lido na importação: defina o env antes dos imports dinâmicos
process.env.WHATSAPP_APP_SECRET = "s3cret";

describe("time", async () => {
  const { localToUtc, nextOccurrence, parseRrule } = await import("../src/core/time.js");

  it("converte horário local do usuário para UTC", () => {
    expect(localToUtc("2026-11-03T15:00", "America/Sao_Paulo")!.toISO()).toBe("2026-11-03T18:00:00.000Z");
    expect(localToUtc("lixo", "America/Sao_Paulo")).toBeNull();
  });

  it("valida o subconjunto de RRULE", () => {
    expect(parseRrule("FREQ=WEEKLY;BYDAY=MO,WE")).toEqual({ freq: "WEEKLY", byDay: [1, 3] });
    expect(parseRrule("FREQ=YEARLY")).toBeNull();
    expect(parseRrule("FREQ=WEEKLY;BYDAY=XX")).toBeNull();
  });

  it("calcula próxima ocorrência semanal mantendo a hora local", () => {
    // segunda 02/11/2026 09:00 SP → próxima segunda 09/11 09:00 SP
    const prev = new Date("2026-11-02T12:00:00Z");
    const next = nextOccurrence("FREQ=WEEKLY;BYDAY=MO", prev, "America/Sao_Paulo", prev);
    expect(next?.toISOString()).toBe("2026-11-09T12:00:00.000Z");
  });

  it("dias úteis pula o fim de semana", () => {
    const fri = new Date("2026-11-06T12:00:00Z"); // sexta
    expect(nextOccurrence("FREQ=WEEKDAYS", fri, "America/Sao_Paulo", fri)?.toISOString()).toBe("2026-11-09T12:00:00.000Z");
  });

  it("recorrência atrasada pula para a próxima ocorrência futura", () => {
    const prev = new Date("2026-11-01T12:00:00Z");
    const now = new Date("2026-11-04T13:00:00Z");
    expect(nextOccurrence("FREQ=DAILY", prev, "America/Sao_Paulo", now)?.toISOString()).toBe("2026-11-05T12:00:00.000Z");
  });
});

describe("formatação por canal", async () => {
  const { formatForChannel, splitMessage } = await import("../src/channels/format.js");
  it("whatsapp usa *negrito* e bullets", () => {
    expect(formatForChannel("## Oi\n**importante**\n- a\n- b", "whatsapp")).toBe("Oi\n*importante*\n• a\n• b");
  });
  it("sms remove marcação", () => {
    expect(formatForChannel("**oi** _tudo_ bem", "sms")).toBe("oi tudo bem");
  });
  it("quebra mensagens longas", () => {
    const parts = splitMessage(("a".repeat(1000) + "\n\n").repeat(10), 3500);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 3500)).toBe(true);
  });
});

describe("crypto", async () => {
  const { encrypt, decrypt } = await import("../src/lib/crypto.js");
  it("ida e volta AES-256-GCM, com IV aleatório", () => {
    const a = encrypt("comprar pão");
    expect(a).not.toBe(encrypt("comprar pão"));
    expect(decrypt(a)).toBe("comprar pão");
  });
  it("detecta adulteração", () => {
    const [v, iv, tag, ct] = encrypt("x").split(":");
    expect(() => decrypt([v, iv, tag, Buffer.from("y").toString("base64")].join(":"))).toThrow();
    expect(ct).toBeTruthy();
  });
});

describe("whatsapp", async () => {
  const { verifyWhatsApp, parseWhatsApp } = await import("../src/channels/whatsapp.js");
  const body = {
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: "5511999990000", profile: { name: "Ana Souza" } }],
      messages: [{ from: "5511999990000", id: "wamid.1", timestamp: "1793480000", type: "text", text: { body: "oi" } }],
    } }] }],
  };
  it("valida assinatura HMAC", () => {
    const raw = Buffer.from(JSON.stringify(body));
    const sig = "sha256=" + createHmac("sha256", "s3cret").update(raw).digest("hex");
    expect(verifyWhatsApp(raw, sig)).toBe(true);
    expect(verifyWhatsApp(raw, sig.replace(/.$/, "0"))).toBe(false);
    expect(verifyWhatsApp(raw, undefined)).toBe(false);
  });
  it("normaliza mensagem", () => {
    expect(parseWhatsApp(body)[0]).toMatchObject({ channel: "whatsapp", externalUserId: "5511999990000", phone: "5511999990000", text: "oi", displayName: "Ana Souza" });
  });
});

describe("telegram", async () => {
  const { parseTelegram } = await import("../src/channels/telegram.js");
  it("só aceita contato do próprio remetente", () => {
    const own = parseTelegram({ update_id: 1, message: { chat: { id: 9, type: "private" }, from: { id: 9 }, contact: { phone_number: "+55 11 99999-0000", user_id: 9 } } });
    expect(own?.contactPhone).toBe("5511999990000");
    const other = parseTelegram({ update_id: 2, message: { chat: { id: 9, type: "private" }, from: { id: 9 }, contact: { phone_number: "+5511888880000", user_id: 7 } } });
    expect(other).toBeNull();
  });
  it("ignora grupos", () => {
    expect(parseTelegram({ update_id: 3, message: { chat: { id: -1, type: "group" }, text: "oi" } })).toBeNull();
  });
});

describe("onboarding helpers", async () => {
  const { extractName, resolveTimezone } = await import("../src/core/onboarding.js");
  it("extrai nome", () => {
    expect(extractName("me chamo maria clara")).toBe("Maria Clara");
    expect(extractName("Oi, sou o João!")).toBe("João");
    expect(extractName("12345")).toBeNull();
  });
  it("resolve fuso por cidade", () => {
    expect(resolveTimezone("Manaus")).toBe("America/Manaus");
    expect(resolveTimezone("moro em São Paulo")).toBe("America/Sao_Paulo");
    expect(resolveTimezone("Europe/Lisbon")).toBe("Europe/Lisbon");
    expect(resolveTimezone("Xyzlândia")).toBeNull();
  });
});

describe("dados sensíveis (RN-18)", async () => {
  const { looksSensitive } = await import("../src/core/memories.js");
  it("bloqueia saúde, finanças e documentos", () => {
    expect(looksSensitive("meu cpf é 123.456.789-00")).toBe(true);
    expect(looksSensitive("tomo remédio pra pressão")).toBe(true);
    expect(looksSensitive("senha do wifi")).toBe(true);
    expect(looksSensitive("aniversario 12 de março")).toBe(false);
    expect(looksSensitive("cachorro se chama Thor")).toBe(false);
  });
});

describe("agente", async () => {
  const { sanitizeInput } = await import("../src/agent/agent.js");
  const { CUSTOM_TOOLS } = await import("../src/agent/tools.js");
  it("remove caracteres de controle e bidi", () => {
    expect(sanitizeInput("oi‮abc\u0000")).toBe("oiabc");
  });
  it("todas as ferramentas são strict com schema fechado", () => {
    for (const t of CUSTOM_TOOLS) {
      expect(t.strict).toBe(true);
      expect((t.input_schema as any).additionalProperties).toBe(false);
      expect((t.input_schema as any).required).toEqual(Object.keys((t.input_schema as any).properties));
    }
  });
});

describe("fala (RF-07)", async () => {
  const { parseWavHeader } = await import("../src/speech/nvidia.js");
  const { FallbackTranscriber } = await import("../src/speech/index.js");

  it("lê taxa e canais do cabeçalho WAV", () => {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.write("WAVE", 8); h.write("fmt ", 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(22050, 24);
    h.write("data", 36);
    expect(parseWavHeader(h)).toEqual({ sampleRate: 22050, channels: 1 });
    expect(parseWavHeader(Buffer.from("OggS".padEnd(50, "x")))).toBeNull();
  });

  it("cai para o próximo provedor quando o primeiro falha", async () => {
    const t = new FallbackTranscriber([
      { name: "a", transcribe: async () => { throw new Error("sem créditos"); } },
      { name: "b", transcribe: async () => "olá juca" },
    ]);
    expect(await t.transcribe(Buffer.alloc(1), "audio/ogg")).toBe("olá juca");
  });

  it("propaga o erro se todos falharem", async () => {
    const t = new FallbackTranscriber([{ name: "a", transcribe: async () => { throw new Error("x"); } }]);
    await expect(t.transcribe(Buffer.alloc(1), "audio/ogg")).rejects.toThrow("x");
  });
});

describe("ferramentas web por modelo", async () => {
  const { serverTools } = await import("../src/agent/tools.js");
  const types = (model: string) => serverTools({ model, webSearch: true, linkSummary: true, timezone: "America/Sao_Paulo" }).map((t: any) => t.type);
  it("Haiku usa as variantes básicas", () => {
    expect(types("claude-haiku-5-5")).toEqual(["web_search_20250305", "web_fetch_20250910"]);
  });
  it("Opus/Sonnet usam filtragem dinâmica", () => {
    expect(types("claude-opus-5-5")).toEqual(["web_search_20260209", "web_fetch_20260209"]);
    expect(types("claude-sonnet-5-5")).toEqual(["web_search_20260209", "web_fetch_20260209"]);
  });
});
