import { promises as fs } from "node:fs";
import path from "node:path";

export async function replaceWithAtomicFile(
  targetPath: string,
  producer: (temporaryPath: string) => Promise<void>,
): Promise<{ bytes: number; temporaryPath: string }> {
  const absoluteTarget = path.resolve(targetPath);
  const temporaryPath = `${absoluteTarget}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(absoluteTarget), { recursive: true, mode: 0o700 });
  try {
    await producer(temporaryPath);
    const stat = await fs.stat(temporaryPath);
    if (!stat.isFile() || stat.size === 0) throw new Error("Backup producer created an empty file");
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, absoluteTarget);
    return { bytes: stat.size, temporaryPath };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}
