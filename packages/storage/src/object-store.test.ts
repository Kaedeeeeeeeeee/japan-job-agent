import { describe, expect, it } from "vitest";
import { MemoryRawObjectStore } from "./object-store.js";

describe("raw object storage", () => {
  it("does not overwrite an existing immutable object", async () => {
    const store = new MemoryRawObjectStore();
    await store.putIfAbsent("raw/hash", new Uint8Array([1]), "application/json");
    await store.putIfAbsent("raw/hash", new Uint8Array([2]), "application/json");
    expect(store.objects.get("raw/hash")).toEqual(new Uint8Array([1]));
    expect(await store.get("raw/hash")).toEqual(new Uint8Array([1]));
  });

  it("deletes raw objects idempotently", async () => {
    const store = new MemoryRawObjectStore();
    await store.putIfAbsent("raw/hash", new Uint8Array([1]), "application/json");
    await store.delete("raw/hash");
    await store.delete("raw/hash");
    await expect(store.get("raw/hash")).rejects.toThrow("does not exist");
  });
});
