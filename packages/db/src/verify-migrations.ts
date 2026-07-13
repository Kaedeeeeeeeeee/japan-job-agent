import pg from "pg";
import { promises as fs } from "node:fs";
import path from "node:path";
import { migrate } from "./migrate.js";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
await migrate(databaseUrl);

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const result = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM schema_migrations");
  const expected = (await fs.readdir(path.resolve(import.meta.dirname, "../migrations"))).filter((file) => file.endsWith(".sql")).length;
  if (Number(result.rows[0]?.count ?? 0) !== expected) throw new Error(`expected ${expected} migrations to be applied`);
} finally {
  await client.end();
}
