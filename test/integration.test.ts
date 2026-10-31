/**
 * Integração ponta a ponta (Postgres + Redis reais, canais e LLM simulados).
 * Rode com: docker compose up -d && npm run migrate && INTEGRATION=1 npm test
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const RUN = process.env.INTEGRATION === "1";
const sent: { to: string; text: string; opts?: unknown }[] = [];

vi.mock("../src/channels/index.js", () => {
  const adapter = (name: string) => ({
    name,
    send: async (to: string, text: string, opts?: unknown) => {
      sent.push({ to, text, opts });
    },
  });
  return { channels: { telegram: adapter("telegram"), whatsapp: adapter("whatsapp") } };
});

// LLM simulado: responde de forma fixa e devolve uma ação pendente quando pedem "apaga tudo"
vi.mock("../src/agent/agent.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    runAgent: async (_user: any, _hist: any, text: string) => {
      if (/apaga tudo/i.test(text)) {
        const prompt = "Confirma? Responda SIM para apagar.";
        return { text: prompt, pending: { kind: "delete_all_data", args: {}, prompt, expiresAt: new Date(Date.now() + 60_000).toISOString() }, usage: { input: 1, output: 1 }, model: "mock" };
      }
      return { text: `eco: ${text}`, usage: { input: 1, output: 1 }, model: "mock" };
    },
  };
});

describe.skipIf(!RUN)("fluxo completo", () => {
  let handleInbound: typeof import("../src/core/handler.js").handleInbound;
  let query: typeof import("../src/db/pool.js").query;
  let createReminder: typeof import("../src/core/reminders.js").createReminder;
  let dispatchDueReminders: typeof import("../src/jobs/reminders.js").dispatchDueReminders;
  let pool: typeof import("../src/db/pool.js").pool;
  let redis: typeof import("../src/lib/redis.js").redis;
  const wa = "55119" + String(Date.now()).slice(-8);
  let n = 0;
  const msg = (text: string) => ({ channel: "whatsapp" as const, externalUserId: wa, externalMessageId: `m${Date.now()}-${n++}`, phone: wa, displayName: "Ana Souza", text, receivedAt: new Date().toISOString() });
  const last = () => sent[sent.length - 1]!.text;

  beforeAll(async () => {
    ({ handleInbound } = await import("../src/core/handler.js"));
    ({ query, pool } = await import("../src/db/pool.js"));
    ({ createReminder } = await import("../src/core/reminders.js"));
    ({ dispatchDueReminders } = await import("../src/jobs/reminders.js"));
    ({ redis } = await import("../src/lib/redis.js"));
  });
  afterAll(async () => {
    await pool.end();
    redis.disconnect();
  });

  it("onboarding: IA declarada, OTP, termos, nome, fuso", async () => {
    await handleInbound(msg("oi"));
    expect(sent.some((s) => /assistente de inteligência artificial/.test(s.text))).toBe(true);
    const code = sent.map((s) => s.text.match(/código do Juca: (\d{6})/)?.[1]).find(Boolean)!;
    expect(code).toMatch(/^\d{6}$/);

    // antes de aceitar termos, nada chega ao agente (RN-02)
    await handleInbound(msg("000000"));
    expect(last()).toMatch(/não bateu/);
    await handleInbound(msg(code));
    expect(last()).toMatch(/ACEITO/);
    await handleInbound(msg("me lembra de algo"));
    expect(last()).toMatch(/aceite os termos/);
    await handleInbound(msg("Aceito"));
    expect(last()).toMatch(/Posso te chamar de Ana/);
    await handleInbound(msg("pode sim"));
    expect(last()).toMatch(/Prazer, Ana/);
    await handleInbound(msg("Manaus"));
    expect(last()).toMatch(/Tudo pronto, Ana/);

    const u = await query("SELECT * FROM users WHERE phone = $1", [wa]);
    expect(u.rows[0]).toMatchObject({ status: "active", timezone: "America/Manaus", phone_verified: true, is_adult: true });
  });

  it("mensagem duplicada é ignorada (RNF-24)", async () => {
    const m = msg("teste");
    await handleInbound(m);
    const before = sent.length;
    await handleInbound(m);
    expect(sent.length).toBe(before);
  });

  it("conversa passa pelo agente e é gravada cifrada", async () => {
    await handleInbound(msg("qual a capital da França?"));
    expect(last()).toBe("eco: qual a capital da França?");
    const r = await query("SELECT content_enc FROM messages m JOIN users u ON u.id = m.user_id WHERE u.phone = $1 ORDER BY m.id DESC LIMIT 1", [wa]);
    expect(r.rows[0].content_enc).toMatch(/^v1:/);
  });

  it("lembrete no passado é rejeitado e lembrete vencido é disparado", async () => {
    const u = (await query("SELECT * FROM users WHERE phone = $1", [wa])).rows[0];
    await expect(createReminder(u.id, u.timezone, "x", "2020-01-01T10:00")).rejects.toThrow(/passou/);
    const r = await createReminder(u.id, u.timezone, "beber água", new Date(Date.now() + 60_000).toISOString().slice(0, 16).replace("Z", ""), "FREQ=DAILY");
    await query("UPDATE reminders SET due_at = now() - interval '1 second' WHERE id = $1", [r.id]);
    await dispatchDueReminders();
    expect(sent.some((s) => s.text.includes("⏰ Lembrete: beber água"))).toBe(true);
    const after = (await query("SELECT status, due_at FROM reminders WHERE id = $1", [r.id])).rows[0];
    expect(after.status).toBe("active"); // recorrente: reagendado
    expect(new Date(after.due_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("pausar e voltar (RF-28)", async () => {
    await handleInbound(msg("pausar"));
    expect(last()).toMatch(/fico quietinho/);
    const before = sent.length;
    await handleInbound(msg("oi?"));
    expect(sent.length).toBe(before);
    await handleInbound(msg("voltar"));
    expect(last()).toMatch(/Voltei, Ana/);
  });

  it("feedback 👎 grava avaliação (RF-29)", async () => {
    await handleInbound(msg("👎"));
    const r = await query("SELECT rating FROM messages m JOIN users u ON u.id=m.user_id WHERE u.phone=$1 AND role='assistant' ORDER BY m.id DESC LIMIT 1", [wa]);
    expect(r.rows[0].rating).toBe(-1);
  });

  it("apagar tudo exige confirmação e remove os dados (RF-18/RF-26)", async () => {
    await handleInbound(msg("apaga tudo"));
    expect(last()).toMatch(/Confirma/);
    expect(sent[sent.length - 1]!.opts).toMatchObject({ quickReplies: ["Sim", "Não"] });
    await handleInbound(msg("sim"));
    expect(last()).toMatch(/Apaguei tudo/);
    const u = await query("SELECT 1 FROM users WHERE phone = $1", [wa]);
    expect(u.rowCount).toBe(0);
    const a = await query("SELECT action FROM audit_log WHERE action = 'data_deleted' ORDER BY id DESC LIMIT 1");
    expect(a.rowCount).toBe(1);
  });
});
