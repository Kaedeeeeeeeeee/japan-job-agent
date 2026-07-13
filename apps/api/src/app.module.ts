import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AppController } from "./app.controller.js";
import { AdminController } from "./admin.controller.js";
import { DatabaseService } from "./database.service.js";
import { AgentController } from "./agent.controller.js";
import { InternalApiGuard } from "./internal-api.guard.js";

@Module({
  controllers: [AppController, AdminController, AgentController],
  providers: [DatabaseService, { provide: APP_GUARD, useClass: InternalApiGuard }],
})
export class AppModule {}
