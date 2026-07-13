import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorizeInternalApi } from "../../../packages/security/src/internal-api-auth.js";

@Injectable()
export class InternalApiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const allowed = authorizeInternalApi({
      path: request.url,
      authorization: request.headers.authorization,
      configuredToken: process.env.API_INTERNAL_TOKEN,
      production: process.env.NODE_ENV === "production",
    });
    if (!allowed) throw new UnauthorizedException("Valid internal API authorization is required");
    return true;
  }
}
