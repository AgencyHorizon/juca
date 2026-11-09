/** Convites, lista de espera, skills e guardas de persistência (com INTEGRATION=1, no banco de testes). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.INVITE_ONLY = "true";
process.env.TELEGRAM_BOT_USERNAME = "JucaBot";

describe("códigos de convite", async () => {
  const { generateCode, parseInviteCode, inviteLink } = await import("../src/core/invites.js");
  it("gera, reconhece e monta o link", () => {
    const c = generateCode();
    expect(c).toMatch(/^JUCA-[A-Z2-9]{6}$/);
    expect(parseInviteCode(`/start ${c.toLowerCase()}`)).toBe(c);
    expect(parseInviteCode("oi")).toBeNull();
    expect(inviteLink(c)).toBe(`https://t.me/JucaBot?start=${c}`);
  });
});

describe("guardas de turno", async () => {
  const { executeTool } = await import("../src/agent/tools.js");
  const { newToolContext } = await import("../src/agent/connector-tools.js");
  const user: any = { id: -1, timezone: "America/Sao_Paulo", cohort: "beta" };
  it("o que é permanente não nasce de turno que leu conteúdo externo", async () => {
    for (const name of ["create_routine", "save_skill", "set_my_instructions", "invite_friend"]) {
      const ctx = { ...newToolContext("x"), tainted: true };
      expect(JSON.parse((await executeTool(user, name, {}, ctx)).content).error, name).toBe("needs_new_message");
    }
  });
  it("rotina não muda preferências nem gera convites", async () => {
    for (const name of ["save_skill", "set_my_instructions", "invite_friend"]) {
      expect(JSON.parse((await executeTool(user, name, {}, newToolContext("", true))).content).error, name).toBe("needs_approval");
    }
  });
});

const RUN = process.env.INTEGRATION === "1";
const sent: { to: string; text: string }[] = [];
vi.mock("../src/channels/index.js", () => {
  const adapter = (name: string) => ({ name, send: async (to: string, text: string) => void sent.push({ to, text }) });
  return { channels: { telegram: adapter("telegram"), whatsapp: adapter("whatsapp") } };
});

describe.skipIf(!RUN)("entrada por convite", () => {
  const m: any = {};
  const stamp = Date.now();
  let n = 0;
  const say = (chat: string, text: string) =>
    m.handler.handleInbound({ channel: "telegram", externalUserId: chat, externalMessageId: `i${stamp}${n++}`, text, displayName: "Ana", receivedAt: new Date().toISOString() });
  const last = () => sent.at(-1)!.text;
  const userOf = async (chat: string) => (await m.pool.query("SELECT u.* FROM users u JOIN channel_identities c ON c.user_id=u.id WHERE c.external_id=$1", [chat])).rows[0];

  beforeAll(async () => {
    m.handler = await import("../src/core/handler.js");
    m.pool = await import("../src/db/pool.js");
    m.inv = await import("../src/core/invites.js");
    m.skills = await import("../src/core/skills.js");
  });
  afterAll(async () => {
    await m.pool.query("DELETE FROM users WHERE id IN (SELECT user_id FROM channel_identities WHERE external_id LIKE $1)", [`inv-${stamp}%`]);
    await m.pool.pool.end();
    (await import("../src/lib/redis.js")).redis.disconnect();
  });

  it("sem convite vai para a lista de espera e não chega ao cadastro", async () => {
    await say(`inv-${stamp}-a`, "/start");
    expect(last()).toMatch(/só entro por convite/);
    expect((await userOf(`inv-${stamp}-a`)).onboarding_step).toBe("waitlist");
    await say(`inv-${stamp}-a`, "me deixa entrar");
    expect(last()).toMatch(/lista de espera/);
    await say(`inv-${stamp}-a`, "JUCA-ZZZZZZ");
    expect(last()).toMatch(/não é válido/);
  });

  it("código na lista de espera libera; link /start libera direto; é de uso único", async () => {
    const code = await m.inv.createInvite(null);
    await say(`inv-${stamp}-a`, code);
    expect(last()).toMatch(/Compartilhar|botão/);
    expect((await userOf(`inv-${stamp}-a`)).invite_accepted).toBe(true);

    await say(`inv-${stamp}-b`, `/start ${code}`);
    expect(last()).toMatch(/não é válido ou já foi usado/);

    const code2 = await m.inv.createInvite(null);
    await say(`inv-${stamp}-c`, `/start ${code2}`);
    expect((await userOf(`inv-${stamp}-c`)).onboarding_step).toBe("await_contact");
  });

  it("convite do usuário respeita o saldo e não passa do limite", async () => {
    const u = await userOf(`inv-${stamp}-c`);
    for (const left of [2, 1, 0]) expect((await m.inv.issueInvite(u)).left).toBe(left);
    await expect(m.inv.issueInvite(u)).rejects.toThrow(/não tem mais/);
  });

  it("corrida: dois usos simultâneos, um vence", async () => {
    const code = await m.inv.createInvite(null);
    const a = await userOf(`inv-${stamp}-a`);
    const c = await userOf(`inv-${stamp}-c`);
    const r = await Promise.all([m.inv.claimInvite(code, a.id), m.inv.claimInvite(code, c.id)]);
    expect(r.filter(Boolean)).toHaveLength(1);
  });

  it("skill salva vira instrução com /nome; comando desconhecido não é skill", async () => {
    const u = await userOf(`inv-${stamp}-a`);
    expect(await m.skills.saveSkill(u.id, "/Bom Dia", "resuma meus e-mails")).toBe("bom_dia");
    expect(await m.skills.expandSkill(u.id, "/bom_dia só os urgentes")).toMatch(/resuma meus e-mails[\s\S]*só os urgentes/);
    expect(await m.skills.expandSkill(u.id, "/naoexiste")).toBeNull();
    expect(await m.skills.expandSkill(u.id, "oi")).toBeNull();
    await expect(m.skills.saveSkill(u.id, "start", "x")).rejects.toThrow(/outro nome/);
  });
});
