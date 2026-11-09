import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Testes de integração usam um banco próprio: nunca os dados reais do Juca (npm run test:setup).
    env: { DATABASE_URL: "postgres://juca:juca@localhost:5432/juca_test", INVITE_ONLY: "false" },
    fileParallelism: false,
  },
});
