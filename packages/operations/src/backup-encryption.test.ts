import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decryptBackupFile,
  encryptBackupFile,
  isEncryptedBackup,
  parseBackupEncryptionKey,
} from "./backup-encryption.js";

const created: string[] = [];

afterEach(async () => Promise.all(created.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

describe("database backup encryption", () => {
  it("round-trips a backup with authenticated AES-256-GCM", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jja-backup-encryption-"));
    created.push(directory);
    const input = path.join(directory, "database.dump");
    const encrypted = path.join(directory, "database.dump.enc");
    const restored = path.join(directory, "restored.dump");
    const plaintext = Buffer.concat([Buffer.from("PGDMP private fixture"), randomBytes(128 * 1024)]);
    const key = randomBytes(32).toString("base64");
    await fs.writeFile(input, plaintext);
    await encryptBackupFile(input, encrypted, key);
    expect(await isEncryptedBackup(encrypted)).toBe(true);
    expect(await isEncryptedBackup(input)).toBe(false);
    expect((await fs.readFile(encrypted)).includes(Buffer.from("PGDMP private fixture"))).toBe(false);
    await decryptBackupFile(encrypted, restored, key);
    expect(await fs.readFile(restored)).toEqual(plaintext);
    expect((await fs.stat(encrypted)).mode & 0o777).toBe(0o600);
  });

  it("fails closed with a wrong key and removes partial plaintext", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jja-backup-encryption-"));
    created.push(directory);
    const input = path.join(directory, "database.dump");
    const encrypted = path.join(directory, "database.dump.enc");
    const restored = path.join(directory, "restored.dump");
    await fs.writeFile(input, "PGDMP private fixture");
    await encryptBackupFile(input, encrypted, randomBytes(32).toString("base64"));
    await expect(decryptBackupFile(encrypted, restored, randomBytes(32).toString("base64"))).rejects.toThrow();
    await expect(fs.access(restored)).rejects.toThrow();
  });

  it("rejects invalid or non-canonical key material", () => {
    expect(() => parseBackupEncryptionKey(Buffer.alloc(31).toString("base64"))).toThrow("32-byte key");
    expect(() => parseBackupEncryptionKey(`${Buffer.alloc(32).toString("base64")}=`)).toThrow("canonical");
  });
});
