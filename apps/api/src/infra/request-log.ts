import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type LogFormat = "text" | "json";
export type LogSink = (line: string) => void;

/** Probes hit these every few seconds; a successful one is noise, a failing one is still logged. */
const QUIET = new Set(["/health", "/ready"]);
const VALID_ID = /^[A-Za-z0-9._:-]{8,64}$/;

/**
 * Request id for every request: the caller's `X-Request-Id` when it is a sane token (so a client or proxy can follow
 * one request end to end), otherwise a fresh UUID. Never trust the header blindly: it ends up in logs.
 */
export function genRequestId(req: { headers: IncomingMessage["headers"] }): string {
  const h = req.headers["x-request-id"];
  return typeof h === "string" && VALID_ID.test(h) ? h : randomUUID();
}

/**
 * One line per finished request: time, id, method, path, status, duration, client IP and who made it.
 * Deliberately left out: query strings, headers and bodies (they can carry tokens, passwords and financial data).
 */
export function registerRequestLog(app: FastifyInstance, opts: { format: LogFormat; sink?: LogSink }) {
  const sink: LogSink = opts.sink ?? ((line) => process.stdout.write(`${line}\n`));
  app.addHook("onRequest", async (req, reply) => { void reply.header("x-request-id", req.id); });
  app.addHook("onResponse", async (req, reply) => {
    const path = req.url.split("?")[0] ?? req.url;
    if (QUIET.has(path) && reply.statusCode < 400) return;
    sink(formatLine(req, reply, path, opts.format));
  });
}

function formatLine(req: FastifyRequest, reply: FastifyReply, path: string, format: LogFormat): string {
  const status = reply.statusCode;
  const entry = {
    time: new Date().toISOString(),
    level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
    rid: req.id,
    method: req.method,
    path,
    status,
    ms: Math.round(reply.elapsedTime),
    ip: req.ip,
    user: (req as { userId?: string }).userId,
    admin: (req as { admin?: { adminId: string } }).admin?.adminId,
  };
  if (format === "json") return JSON.stringify(entry);
  const who = entry.user ? ` user=${entry.user}` : entry.admin ? ` admin=${entry.admin}` : "";
  return `${entry.time} ${entry.level.toUpperCase().padEnd(5)} ${entry.method} ${path} ${status} ${entry.ms}ms ip=${entry.ip}${who} rid=${entry.rid}`;
}
