import { Module } from "@nestjs/common";
import { AppController } from "./app.controller.js";
import { AdminController } from "./admin.controller.js";
import { DatabaseService } from "./database.service.js";
import { AgentController } from "./agent.controller.js";

@Module({ controllers: [AppController, AdminController, AgentController], providers: [DatabaseService] })
export class AppModule {}
