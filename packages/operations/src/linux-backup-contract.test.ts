import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Linux encrypted offsite backup contract", () => {
  it("reuses the deployed Worker image and requires all R2 encryption inputs", async () => {
    const compose = await readFile("deploy/linux/compose.yml", "utf8");
    const backup = compose.split("\n  backup:\n")[1];
    expect(backup).toBeDefined();
    expect(backup).toContain("    image: japan-job-agent-worker:latest");
    expect(backup).not.toMatch(/^    build:/mu);
    expect(backup).toContain("BACKUP_OUTPUT_PATH: /data/backups/japan-job-agent.dump.enc");
    for (const variable of [
      "BACKUP_ENCRYPTION_KEY",
      "BACKUP_BUCKET",
      "S3_ENDPOINT",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      expect(backup).toContain(`${variable}: \${${variable}:?`);
    }
  });
});
