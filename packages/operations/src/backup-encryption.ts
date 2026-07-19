import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";

const magic = Buffer.from("JJAENC01", "ascii");
const ivBytes = 12;
const authTagBytes = 16;
const headerBytes = magic.byteLength + ivBytes;

export function parseBackupEncryptionKey(encoded: string): Buffer {
  const normalized = encoded.trim();
  const key = Buffer.from(normalized, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== normalized) {
    key.fill(0);
    throw new Error("BACKUP_ENCRYPTION_KEY must be one canonical base64-encoded 32-byte key");
  }
  return key;
}

export async function isEncryptedBackup(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const prefix = Buffer.alloc(magic.byteLength);
    const { bytesRead } = await handle.read(prefix, 0, prefix.byteLength, 0);
    return bytesRead === magic.byteLength && prefix.equals(magic);
  } finally {
    await handle.close();
  }
}

export async function encryptBackupFile(inputPath: string, outputPath: string, encodedKey: string): Promise<void> {
  const key = parseBackupEncryptionKey(encodedKey);
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  try {
    await fs.writeFile(outputPath, Buffer.concat([magic, iv]), { mode: 0o600 });
    await pipeline(
      createReadStream(inputPath),
      cipher,
      createWriteStream(outputPath, { flags: "a", mode: 0o600 }),
    );
    await fs.appendFile(outputPath, cipher.getAuthTag());
  } catch (error) {
    await fs.rm(outputPath, { force: true });
    throw error;
  } finally {
    key.fill(0);
    iv.fill(0);
  }
}

export async function decryptBackupFile(inputPath: string, outputPath: string, encodedKey: string): Promise<void> {
  const stat = await fs.stat(inputPath);
  if (stat.size <= headerBytes + authTagBytes) throw new Error("Encrypted backup is truncated");
  const handle = await fs.open(inputPath, "r");
  const header = Buffer.alloc(headerBytes);
  const authTag = Buffer.alloc(authTagBytes);
  try {
    const headerRead = await handle.read(header, 0, header.byteLength, 0);
    const tagRead = await handle.read(authTag, 0, authTag.byteLength, stat.size - authTagBytes);
    if (headerRead.bytesRead !== header.byteLength || !header.subarray(0, magic.byteLength).equals(magic)
      || tagRead.bytesRead !== authTag.byteLength) {
      throw new Error("Encrypted backup header is invalid");
    }
  } finally {
    await handle.close();
  }
  const key = parseBackupEncryptionKey(encodedKey);
  const iv = header.subarray(magic.byteLength);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  try {
    await pipeline(
      createReadStream(inputPath, { start: headerBytes, end: stat.size - authTagBytes - 1 }),
      decipher,
      createWriteStream(outputPath, { mode: 0o600 }),
    );
  } catch (error) {
    await fs.rm(outputPath, { force: true });
    throw error;
  } finally {
    key.fill(0);
    header.fill(0);
    authTag.fill(0);
  }
}
