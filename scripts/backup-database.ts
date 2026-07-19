import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { replaceWithAtomicFile } from "../packages/operations/src/atomic-file.js";
import { encryptBackupFile } from "../packages/operations/src/backup-encryption.js";

const databaseUrl = required("DATABASE_URL");
const encryptionKey = required("BACKUP_ENCRYPTION_KEY");
const timestamp = new Date().toISOString().replaceAll(":", "-");
const outputPath = path.resolve(process.env.BACKUP_OUTPUT_PATH ?? `.data/backups/japan-job-agent-${timestamp}.dump.enc`);
const published = await replaceWithAtomicFile(outputPath, async (temporaryPath) => {
  const plaintextPath = `${temporaryPath}.pgdump`;
  try {
    await run(process.env.PG_DUMP_BIN ?? "pg_dump", [
      "--format=custom", "--compress=9", "--no-owner", "--no-acl", `--file=${plaintextPath}`, databaseUrl,
    ]);
    await encryptBackupFile(plaintextPath, temporaryPath, encryptionKey);
  } finally {
    await fs.rm(plaintextPath, { force: true });
  }
});
const sha256 = await hashFile(outputPath);
const bucket = process.env.BACKUP_BUCKET ?? process.env.S3_BUCKET;
let objectKey: string | null = null;
if (bucket !== undefined && bucket !== "") {
  objectKey = `backups/database/${new Date().toISOString().slice(0, 10)}/${path.basename(outputPath)}`;
  const endpoint = process.env.S3_ENDPOINT;
  const client = new S3Client({
    region: process.env.S3_REGION ?? "ap-southeast-1",
    ...(endpoint === undefined || endpoint === "" ? {} : {
      endpoint,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    }),
  });
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: createReadStream(outputPath),
    ContentType: "application/octet-stream", Metadata: { sha256, encryption: "jja-aes-256-gcm-v1" } }));
}
process.stdout.write(`${JSON.stringify({ outputPath, bytes: published.bytes, sha256, encrypted: true,
  bucket: bucket ?? null, objectKey })}\n`);

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
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
