import { promises as fs } from "node:fs";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

export async function migrate(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
  const migrationsDirectory = path.resolve(import.meta.dirname, "../migrations");
  const files = (await fs.readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const filename of files) {
      const applied = await client.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE filename = $1) AS exists",
        [filename],
      );
      if (applied.rows[0]?.exists === true) continue;
      const sql = await fs.readFile(path.join(migrationsDirectory, filename), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(filename) VALUES ($1)", [filename]);
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrate();
}

