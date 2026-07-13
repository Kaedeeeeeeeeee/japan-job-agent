import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface RailwayConfig {
  build: { builder: string; dockerfilePath: string };
  deploy: {
    multiRegionConfig?: Record<string, { numReplicas: number }>;
    startCommand?: string;
    cronSchedule?: string;
    restartPolicyType?: string;
  };
}

const directory = path.resolve(import.meta.dirname, "../../../deploy/railway");
const services = ["api", "web", "worker", "temporal", "backup"];

describe("Railway service config", () => {
  it.each(services)("pins %s to one Singapore replica", async (service) => {
    const config = JSON.parse(await fs.readFile(path.join(directory, `${service}.railway.json`), "utf8")) as RailwayConfig;
    expect(config.build.builder).toBe("DOCKERFILE");
    expect(config.deploy.multiRegionConfig).toEqual({ "asia-southeast1-eqsg3a": { numReplicas: 1 } });
  });

  it("runs the weekly backup as a terminating UTC cron", async () => {
    const config = JSON.parse(await fs.readFile(path.join(directory, "backup.railway.json"), "utf8")) as RailwayConfig;
    expect(config.build.dockerfilePath).toBe("/deploy/docker/Dockerfile.worker");
    expect(config.deploy).toMatchObject({
      startCommand: "pnpm backup:database",
      cronSchedule: "43 18 * * 0",
      restartPolicyType: "NEVER",
    });
  });
});
