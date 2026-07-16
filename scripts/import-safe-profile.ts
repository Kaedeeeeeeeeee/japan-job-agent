import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import pg from "pg";
import { buildSafeProfile, type ProfilePolicy } from "../packages/profile/src/build-profile.js";
import { createAiProviderFromEnv } from "../packages/ai/src/ai-provider.js";
import { aiTaskIdempotencyKey } from "../packages/ai/src/ai-task-service.js";

const resumePath = process.env.RESUME_PATH ?? "/Users/user/resume/resume_ja.html";
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const raw = await fs.readFile(resumePath);
const policyRaw = await fs.readFile(path.resolve("config/profile-policy.json"), "utf8");
const policy = JSON.parse(policyRaw) as ProfilePolicy;
const profile = buildSafeProfile(raw.toString("utf8"), policy);
const fingerprint = createHash("sha256").update(raw).update("\0").update(policyRaw).digest("hex");
const { Client } = pg;
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query("BEGIN");
  const profileRow = await client.query<{ id: string }>(`INSERT INTO profiles(profile_key) VALUES ('primary')
    ON CONFLICT (profile_key) DO UPDATE SET updated_at=now() RETURNING id`);
  const profileId = profileRow.rows[0]?.id;
  if (profileId === undefined) throw new Error("Failed to create Profile");
  const existing = await client.query<{ id: string; version: number }>(`SELECT id,version FROM profile_versions
    WHERE profile_id=$1 AND source_fingerprint=$2`, [profileId, fingerprint]);
  let versionId = existing.rows[0]?.id;
  let version = existing.rows[0]?.version;
  let reused = true;
  if (versionId === undefined || version === undefined) {
    const next = await client.query<{ version: number }>("SELECT coalesce(max(version),0)+1 AS version FROM profile_versions WHERE profile_id=$1", [profileId]);
    version = next.rows[0]?.version ?? 1;
    versionId = randomUUID();
    await client.query(`INSERT INTO profile_versions(id,profile_id,version,schema_version,structured_profile,source_fingerprint,contains_direct_pii)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,false)`, [versionId, profileId, version, profile.schemaVersion, JSON.stringify(profile), fingerprint]);
    reused = false;
  }
  await client.query("UPDATE profiles SET current_version_id=$1,updated_at=now() WHERE id=$2", [versionId, profileId]);
  const provider = createAiProviderFromEnv();
  if (provider !== null && process.env.SEMANTIC_RETRIEVAL_ENABLED === "true") {
    const idempotencyKey = aiTaskIdempotencyKey("profile_embedding", [fingerprint, provider.embeddingModelKey, "profile-embedding-v1"]);
    await client.query(`INSERT INTO ai_tasks(
        task_kind,idempotency_key,payload,provider_key,model_key
      ) VALUES ('profile_embedding',$1,$2::jsonb,$3,$4)
      ON CONFLICT(idempotency_key) DO NOTHING`, [idempotencyKey,
      JSON.stringify({ profileVersionId: versionId, sourceFingerprint: fingerprint }), provider.providerKey, provider.embeddingModelKey]);
  }
  await client.query("COMMIT");
  const outputPath = path.resolve(".data/profile/primary.json");
  await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ profileVersionId: versionId, version, reused,
    skillCount: profile.normalizedSkills.length, experienceSignalCount: profile.experienceSignals.length,
    directPiiStored: profile.piiPolicy.directPiiStored })}\n`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
