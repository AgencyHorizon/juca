import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./pool.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

async function main() {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [f]);
    if (done.rowCount) continue;
    const sql = await readFile(path.join(dir, f), "utf8");
    await pool.query("BEGIN");
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
    await pool.query("COMMIT");
    console.log(`migração aplicada: ${f}`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
