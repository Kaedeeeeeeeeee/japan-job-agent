import { describe, expect, it } from "vitest";
import { assertKnownMigrationsApplied, missingKnownMigrations } from "./migration-verification.js";

describe("migration verification", () => {
  it("accepts additive migrations from a newer or parallel release", () => {
    expect(() => assertKnownMigrationsApplied(["0001.sql", "0018.sql"], ["0001.sql", "0016.sql", "0017.sql", "0018.sql"]))
      .not.toThrow();
  });

  it("rejects a restored database missing a migration known to this release", () => {
    expect(missingKnownMigrations(["0001.sql", "0018.sql"], ["0001.sql"])).toEqual(["0018.sql"]);
    expect(() => assertKnownMigrationsApplied(["0001.sql", "0018.sql"], ["0001.sql"]))
      .toThrow("missing known migrations: 0018.sql");
  });
});
