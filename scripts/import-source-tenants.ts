import { promises as fs } from "node:fs";
import path from "node:path";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { SourceExpansionStore } from "../packages/source-expansion/src/source-expansion-store.js";
import { tenantCandidateArtifactSchema } from "../packages/source-expansion/src/tenant-artifact.js";

const filename = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
if (filename === undefined) throw new Error("Usage: source:import-tenants <artifact> --dry-run|--apply");
const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run");
if (apply === dryRun) throw new Error("Choose exactly one of --dry-run or --apply");
const artifact = tenantCandidateArtifactSchema.parse(JSON.parse(await fs.readFile(path.resolve(filename), "utf8")));
const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({
  pool: new Pool({ connectionString: required("DATABASE_URL") }),
}) });
const store = new SourceExpansionStore(db);
let runId: string | undefined;
try {
  if (apply) runId = await store.beginRun("import", { requestedBatch: artifact.candidates.length });
  const report = await store.importArtifact(artifact, apply);
  if (runId !== undefined) await store.finishRun(runId, "succeeded", { ...report });
  process.stdout.write(`${JSON.stringify({ mode: apply ? "apply" : "dry-run", ...report }, null, 2)}\n`);
} catch (error) {
  if (runId !== undefined) await store.finishRun(runId, "failed", {}, [error instanceof Error ? error.message : String(error)]);
  throw error;
} finally {
  await db.destroy();
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
