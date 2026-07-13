import pg from "pg";
import { migrate } from "./migrate.js";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
await migrate(databaseUrl);

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const result = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM schema_migrations");
  if (Number(result.rows[0]?.count ?? 0) < 4) throw new Error("not all migrations were applied");
} finally {
  await client.end();
}

