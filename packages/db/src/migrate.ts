import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSql } from "./client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function migrate(connectionString?: string) {
  const sql = createSql(connectionString);
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    const migrationsDir = join(__dirname, "..", "migrations");
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const applied = await sql`
        SELECT 1 FROM schema_migrations WHERE id = ${file} LIMIT 1
      `;
      if (applied.length) continue;
      const body = await readFile(join(migrationsDir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations (id) VALUES (${file})`;
      });
      console.log(`Applied migration ${file}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  migrate().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
