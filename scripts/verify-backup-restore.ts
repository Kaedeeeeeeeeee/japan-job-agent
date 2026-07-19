import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { assertKnownMigrationsApplied } from "../packages/db/src/migration-verification.js";
import { decryptBackupFile, isEncryptedBackup } from "../packages/operations/src/backup-encryption.js";

const backupPath = process.env.BACKUP_INPUT_PATH ?? process.argv[2];
if (backupPath === undefined) throw new Error("BACKUP_INPUT_PATH or a backup path argument is required");
await fs.access(backupPath);
const backupStat = await fs.stat(backupPath);
if (!backupStat.isFile() || backupStat.size === 0) throw new Error("Backup file is empty");
const restoreUrl = required("RESTORE_DATABASE_URL");
if (restoreUrl === process.env.DATABASE_URL) throw new Error("Refusing to restore over DATABASE_URL");
const databaseName = new URL(restoreUrl).pathname.slice(1);
if (!/(restore|test|drill)/i.test(databaseName)) throw new Error("Restore target database name must contain restore, test, or drill");
const encrypted = await isEncryptedBackup(backupPath);
if (process.env.REQUIRE_ENCRYPTED_BACKUP === "true" && !encrypted) {
  throw new Error("Backup is not application-encrypted");
}
const temporaryDirectory = encrypted ? await fs.mkdtemp(path.join(os.tmpdir(), "jja-backup-restore-")) : null;
const restoreInput = temporaryDirectory === null ? backupPath : path.join(temporaryDirectory, "database.dump");
try {
  if (encrypted) await decryptBackupFile(backupPath, restoreInput, required("BACKUP_ENCRYPTION_KEY"));
  await run(process.env.PG_RESTORE_BIN ?? "pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-acl", `--dbname=${restoreUrl}`, restoreInput]);
  const { Client } = pg;
  const client = new Client({ connectionString: restoreUrl });
  await client.connect();
  try {
    const result = await client.query<{
      migrations: string;
      sources: string;
      canonical_jobs: string;
      invalid_indexes: string;
      unvalidated_foreign_keys: string;
    }>(`SELECT
      (SELECT count(*)::text FROM schema_migrations) migrations,
      (SELECT count(*)::text FROM source_instances) sources,
      (SELECT count(*)::text FROM canonical_jobs) canonical_jobs,
      (SELECT count(*)::text FROM pg_index WHERE NOT indisvalid) invalid_indexes,
      (SELECT count(*)::text FROM pg_constraint WHERE contype = 'f' AND NOT convalidated) unvalidated_foreign_keys`);
    const row = result.rows[0];
    if (row === undefined) throw new Error("Restored database verification returned no rows");
    const migrationFiles = (await fs.readdir(path.resolve(import.meta.dirname, "../packages/db/migrations")))
      .filter((file) => file.endsWith(".sql"));
    const applied = await client.query<{ filename: string }>("SELECT filename FROM schema_migrations ORDER BY filename");
    assertKnownMigrationsApplied(migrationFiles, applied.rows.map(({ filename }) => filename));
    if (Number(row.invalid_indexes) !== 0 || Number(row.unvalidated_foreign_keys) !== 0) {
      throw new Error(`Restored database integrity failed: ${row.invalid_indexes} invalid indexes, `
        + `${row.unvalidated_foreign_keys} unvalidated foreign keys`);
    }
    process.stdout.write(`${JSON.stringify({ restored: true, encrypted, databaseName,
      knownMigrations: migrationFiles.length, ...row })}\n`);
  } finally {
    await client.end();
  }
} finally {
  if (temporaryDirectory !== null) await fs.rm(temporaryDirectory, { recursive: true, force: true });
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
