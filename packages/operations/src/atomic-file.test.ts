import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceWithAtomicFile } from "./atomic-file.js";

const created: string[] = [];

afterEach(async () => Promise.all(created.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

describe("atomic backup output", () => {
  it("publishes a complete non-empty file with private permissions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jja-backup-test-"));
    created.push(directory);
    const target = path.join(directory, "database.dump");
    const result = await replaceWithAtomicFile(target, async (temporary) => fs.writeFile(temporary, "PGDMP fixture"));
    expect(result.bytes).toBeGreaterThan(0);
    expect(await fs.readFile(target, "utf8")).toBe("PGDMP fixture");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  it("preserves an existing backup and removes a failed temporary file", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jja-backup-test-"));
    created.push(directory);
    const target = path.join(directory, "database.dump");
    await fs.writeFile(target, "known-good");
    await expect(replaceWithAtomicFile(target, async (temporary) => {
      await fs.writeFile(temporary, "");
    })).rejects.toThrow(/empty/);
    expect(await fs.readFile(target, "utf8")).toBe("known-good");
    expect((await fs.readdir(directory)).sort()).toEqual(["database.dump"]);
  });
});
