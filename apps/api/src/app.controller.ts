import { Controller, Get, Inject } from "@nestjs/common";
import { DatabaseService } from "./database.service.js";

@Controller()
export class AppController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Get("/health")
  health(): { status: "ok"; version: "0.2.0" } {
    return { status: "ok", version: "0.2.0" };
  }

  @Get("/health/ready")
  async ready(): Promise<{ status: "ready"; version: "0.2.0"; database: "ok" }> {
    await this.database.query("SELECT 1");
    return { status: "ready", version: "0.2.0", database: "ok" };
  }
}
