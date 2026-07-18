import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface RawObjectStore {
  putIfAbsent(key: string, bytes: Uint8Array, contentType: string | null): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export class S3RawObjectStore implements RawObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async putIfAbsent(key: string, bytes: Uint8Array, contentType: string | null): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType ?? "application/octet-stream",
        IfNoneMatch: "*",
        ServerSideEncryption: "AES256",
      }));
    } catch (error) {
      const status = typeof error === "object" && error !== null && "$metadata" in error
        ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
        : undefined;
      if (status !== 412) throw error;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (response.Body === undefined) throw new Error(`S3 object ${key} has no body`);
    return Uint8Array.from(await response.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export class MemoryRawObjectStore implements RawObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async putIfAbsent(key: string, bytes: Uint8Array, _contentType: string | null): Promise<void> {
    if (!this.objects.has(key)) this.objects.set(key, bytes.slice());
  }


  async get(key: string): Promise<Uint8Array> {
    const value = this.objects.get(key);
    if (value === undefined) throw new Error(`Object ${key} does not exist`);
    return value.slice();
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export class FileRawObjectStore implements RawObjectStore {
  constructor(private readonly rootDirectory: string) {}

  async putIfAbsent(key: string, bytes: Uint8Array, _contentType: string | null): Promise<void> {
    const target = path.resolve(this.rootDirectory, key);
    const root = path.resolve(this.rootDirectory);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Object key escaped storage root");
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }


  async get(key: string): Promise<Uint8Array> {
    const target = this.resolveKey(key);
    return Uint8Array.from(await fs.readFile(target));
  }

  async delete(key: string): Promise<void> {
    const target = this.resolveKey(key);
    try {
      await fs.unlink(target);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  private resolveKey(key: string): string {
    const target = path.resolve(this.rootDirectory, key);
    const root = path.resolve(this.rootDirectory);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Object key escaped storage root");
    return target;
  }
}
