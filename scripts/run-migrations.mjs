// Run SQL migrations against local PostgreSQL.
// Usage: node scripts/run-migrations.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", "server", ".env") });
const MIGRATIONS_DIR = join(__dirname, "..", "sql", "migrations");

// zone -> db name
const ZONES = {
  core: process.env.PGDATABASE_CORE || "hyperoom_core",
  chat: process.env.PGDATABASE_CHAT || "hyperoom_chat",
  storage: process.env.PGDATABASE_STORAGE || "hyperoom_storage",
};

const connection = {
  host: process.env.PGHOST || "127.0.0.1",
  port: parseInt(process.env.PGPORT || "5432", 10),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "",
};

for (const [zone, db] of Object.entries(ZONES)) {
  const client = new pg.Client({ ...connection, database: db });
  try {
    await client.connect();
    await client.query(`
      create table if not exists public._migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )`);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f.startsWith("00"))
      .filter((f) => f.includes(`_${zone}`))
      .sort();
    for (const file of files) {
      const row = await client.query("select 1 from public._migrations where filename = $1", [file]);
      if (row.rowCount > 0) { console.log(`[${zone}] skip ${file} (already applied)`); continue; }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("insert into public._migrations (filename) values ($1)", [file]);
        await client.query("COMMIT");
        console.log(`[${zone}] applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[${zone}] FAILED ${file}:`, err.message);
        throw err;
      }
    }
    await client.end();
  } catch (err) {
    console.error(`[${zone}] connection error:`, err.message);
    process.exitCode = 1;
  }
}
console.log("migrations done");