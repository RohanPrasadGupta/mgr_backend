import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";

export async function createApp(opts: { logger?: boolean } = {}) {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true, bodyLimit: 10 * 1024 * 1024 }), {
    logger: opts.logger === false ? false : ["error", "warn", "log"],
  });
  await app.register(helmet);
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    credentials: true,
    // @fastify/cors only allows GET/HEAD/POST by default, which silently breaks PATCH/PUT/DELETE from any browser app on another origin.
    methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86_400,
  });
  await app.register(rateLimit, { max: config.NODE_ENV === "test" ? 10_000 : 300, timeWindow: "1 minute" });
  app.setGlobalPrefix("v1", { exclude: ["health", "ready", "openapi.json"] });
  app.enableShutdownHooks();
  return app;
}
