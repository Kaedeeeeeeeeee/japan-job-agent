import pg from "pg";
import { promises as fs } from "node:fs";
import path from "node:path";
import { migrate } from "./migrate.js";
import { assertKnownMigrationsApplied } from "./migration-verification.js";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
await migrate(databaseUrl);

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const applied = await client.query<{ filename: string }>("SELECT filename FROM schema_migrations ORDER BY filename");
  const known = (await fs.readdir(path.resolve(import.meta.dirname, "../migrations"))).filter((file) => file.endsWith(".sql"));
  assertKnownMigrationsApplied(known, applied.rows.map(({ filename }) => filename));
} finally {
  await client.end();
}
