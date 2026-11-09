/** Cria o banco juca_test e aplica as migrações, para os testes nunca tocarem nos dados reais. */
import { execFileSync } from "node:child_process";
import pg from "pg";

const admin = new pg.Client({ connectionString: "postgres://juca:juca@localhost:5432/postgres" });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'juca_test'");
if (!exists.rowCount) await admin.query("CREATE DATABASE juca_test");
await admin.end();

execFileSync("npx", ["tsx", "src/db/migrate.ts"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL: "postgres://juca:juca@localhost:5432/juca_test" },
});
