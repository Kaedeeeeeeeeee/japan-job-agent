import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { assertProductionApiToken } from "../../../packages/security/src/internal-api-auth.js";

async function bootstrap(): Promise<void> {
  assertProductionApiToken(process.env.API_INTERNAL_TOKEN, process.env.NODE_ENV === "production");
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
  );
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });
}

void bootstrap();
