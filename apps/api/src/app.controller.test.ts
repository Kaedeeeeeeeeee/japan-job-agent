import { describe, expect, it, vi } from "vitest";
import { AppController } from "./app.controller.js";
import type { DatabaseService } from "./database.service.js";

describe("AppController readiness", () => {
  it("checks the database before reporting ready", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const controller = new AppController({ query } as unknown as DatabaseService);

    await expect(controller.ready()).resolves.toEqual({ status: "ready", version: "0.2.0", database: "ok" });
    expect(query).toHaveBeenCalledWith("SELECT 1");
  });
});
