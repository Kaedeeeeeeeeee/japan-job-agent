import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import pg from "pg";

const backupPath = process.env.BACKUP_INPUT_PATH ?? process.argv[2];
if (backupPath === undefined) throw new Error("BACKUP_INPUT_PATH or a backup path argument is required");
await fs.access(backupPath);
const restoreUrl = required("RESTORE_DATABASE_URL");
if (restoreUrl === process.env.DATABASE_URL) throw new Error("Refusing to restore over DATABASE_URL");
const databaseName = new URL(restoreUrl).pathname.slice(1);
if (!/(restore|test|drill)/i.test(databaseName)) throw new Error("Restore target database name must contain restore, test, or drill");
await run("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-acl", `--dbname=${restoreUrl}`, backupPath]);
const { Client } = pg;
const client = new Client({ connectionString: restoreUrl });
await client.connect();
try {
  const result = await client.query<{ migrations: string; sources: string; canonical_jobs: string }>(`SELECT
    (SELECT count(*)::text FROM schema_migrations) migrations,
    (SELECT count(*)::text FROM source_instances) sources,
    (SELECT count(*)::text FROM canonical_jobs) canonical_jobs`);
  const row = result.rows[0];
  if (row === undefined || Number(row.migrations) < 7) throw new Error("Restored database is missing migrations");
  process.stdout.write(`${JSON.stringify({ restored: true, databaseName, ...row })}\n`);
} finally {
  await client.end();
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? "unknown"}`)));
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
