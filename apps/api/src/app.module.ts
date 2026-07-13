import { Module } from "@nestjs/common";
import { AppController } from "./app.controller.js";
import { AdminController } from "./admin.controller.js";
import { DatabaseService } from "./database.service.js";

@Module({ controllers: [AppController, AdminController], providers: [DatabaseService] })
export class AppModule {}
