import { Controller, Get } from "@nestjs/common";

@Controller()
export class AppController {
  @Get("/health")
  health(): { status: "ok"; version: "0.2.0" } {
    return { status: "ok", version: "0.2.0" };
  }
}

