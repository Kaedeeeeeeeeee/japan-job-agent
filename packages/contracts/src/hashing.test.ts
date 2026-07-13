import { describe, expect, it } from "vitest";
import { calculateContentHashes } from "./hashing.js";

describe("platform hashing", () => {
  it("keeps exact raw hash separate from versioned semantic content hash", () => {
    const normalize = (bytes: Uint8Array): Uint8Array => new TextEncoder().encode(new TextDecoder().decode(bytes).trim());
    const a = calculateContentHashes(new TextEncoder().encode("job\n"), normalize, "text-v1");
    const b = calculateContentHashes(new TextEncoder().encode("job"), normalize, "text-v1");
    const v2 = calculateContentHashes(new TextEncoder().encode("job"), normalize, "text-v2");
    expect(a.rawHash).not.toBe(b.rawHash);
    expect(a.contentHash).toBe(b.contentHash);
    expect(v2.contentHash).not.toBe(b.contentHash);
  });
});

