import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const databaseUrl = required("DATABASE_URL");
const timestamp = new Date().toISOString().replaceAll(":", "-");
const outputPath = path.resolve(process.env.BACKUP_OUTPUT_PATH ?? `.data/backups/japan-job-agent-${timestamp}.dump`);
await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
await run("pg_dump", ["--format=custom", "--compress=9", "--no-owner", "--no-acl", `--file=${outputPath}`, databaseUrl]);
await fs.chmod(outputPath, 0o600);
const body = await fs.readFile(outputPath);
const sha256 = createHash("sha256").update(body).digest("hex");
const bucket = process.env.BACKUP_BUCKET ?? process.env.S3_BUCKET;
let objectKey: string | null = null;
if (bucket !== undefined && bucket !== "") {
  objectKey = `backups/database/${new Date().toISOString().slice(0, 10)}/${path.basename(outputPath)}`;
  const endpoint = process.env.S3_ENDPOINT;
  const client = new S3Client({
    region: process.env.S3_REGION ?? "ap-southeast-1",
    ...(endpoint === undefined || endpoint === "" ? {} : { endpoint, forcePathStyle: true }),
  });
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: createReadStream(outputPath),
    ContentType: "application/vnd.postgresql.custom-dump", Metadata: { sha256 } }));
}
process.stdout.write(`${JSON.stringify({ outputPath, bytes: body.byteLength, sha256, bucket: bucket ?? null, objectKey })}\n`);

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
