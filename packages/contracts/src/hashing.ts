import { createHash } from "node:crypto";

export interface ContentHash {
  rawHash: string;
  contentHash: string;
  canonicalizationVersion: string;
}

export function calculateContentHashes(
  raw: Uint8Array,
  canonicalize: (input: Uint8Array) => Uint8Array,
  canonicalizationVersion: string,
): ContentHash {
  const digest = (input: Uint8Array): string => createHash("sha256").update(input).digest("hex");
  const canonical = canonicalize(raw);
  return {
    rawHash: digest(raw),
    contentHash: digest(
      Buffer.concat([Buffer.from(`${canonicalizationVersion}\0`, "utf8"), Buffer.from(canonical)]),
    ),
    canonicalizationVersion,
  };
}

