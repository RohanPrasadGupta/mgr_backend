import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import type Redis from "ioredis";
import { KEYS, REDIS, type Keys } from "./infra/kv";
import { genRequestId, registerRequestLog, type LogSink } from "./infra/request-log";
import { MAX_ATTACHMENT_BYTES } from "./modules/attachments/attachments";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";

export async function createApp(opts: { logger?: boolean; requestLog?: LogSink } = {}) {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: config.TRUST_PROXY, bodyLimit: 10 * 1024 * 1024, genReqId: genRequestId }), {
    logger: opts.logger === false ? false : ["error", "warn", "log"],
  });
  // Registered first so even requests rejected by CORS or the rate limiter get logged. Tests pass their own sink.
  if (opts.requestLog || (opts.logger !== false && config.LOG_REQUESTS)) {
    registerRequestLog(app.getHttpAdapter().getInstance(), { format: config.LOG_FORMAT, sink: opts.requestLog });
  }
  await app.register(helmet);
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    credentials: true,
    // @fastify/cors only allows GET/HEAD/POST by default, which silently breaks PATCH/PUT/DELETE from any browser app on another origin.
    methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86_400,
  });
  // Counters live in Redis when configured, so limits hold across instances and restarts.
  const redis = app.get<Redis | null>(REDIS);
  await app.register(rateLimit, {
    max: config.NODE_ENV === "test" ? 10_000 : config.RATE_LIMIT_PER_MIN, timeWindow: "1 minute",
    ...(redis ? { redis, nameSpace: app.get<Keys>(KEYS).rateLimitNamespace, skipOnError: true } : {}),
  });
  await app.register(multipart, { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 5, parts: 6 } });
  app.setGlobalPrefix("v1", { exclude: ["health", "ready", "openapi.json"] });
  app.enableShutdownHooks();
  return app;
}
