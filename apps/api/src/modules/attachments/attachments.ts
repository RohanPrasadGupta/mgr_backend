import { Controller, Delete, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, count, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DB, type Db } from "../../db/db";
import { attachments, transactions } from "../../db/schema";
import { AppError, notFound, unprocessable } from "../../common/errors";
import { STORAGE, type Storage } from "../../infra/storage";
import { UserId } from "../auth/auth.guard";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_PER_TRANSACTION = 10;

/** Decide the type from the bytes, never from the client's Content-Type or file name. */
export function sniff(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 5 && b.toString("latin1", 0, 5) === "%PDF-") return "application/pdf";
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(b.toString("latin1", 8, 12))) return "image/heic";
  return null;
}
const cleanName = (n: string) => (n.split(/[\\/]/).pop() ?? "file").replace(/[\u0000-\u001f\u007f"<>]/g, "").trim().slice(0, 120) || "file";
const pub = (a: typeof attachments.$inferSelect) => ({ id: a.id, transactionId: a.transactionId, fileName: a.fileName, contentType: a.contentType, sizeBytes: a.sizeBytes, createdAt: a.createdAt });

@Injectable()
export class AttachmentsService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(STORAGE) private readonly storage: Storage) {}

  private async tx(userId: string, id: string) {
    const [t] = await this.db.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.id, id), eq(transactions.userId, userId), isNull(transactions.deletedAt)));
    if (!t) throw notFound("Transaction");
  }
  async list(userId: string, transactionId: string) {
    await this.tx(userId, transactionId);
    return (await this.db.select().from(attachments).where(and(eq(attachments.transactionId, transactionId), eq(attachments.userId, userId))).orderBy(attachments.createdAt)).map(pub);
  }
  async upload(userId: string, transactionId: string, fileName: string, data: Buffer) {
    await this.tx(userId, transactionId);
    if (!data.length) throw unprocessable("empty_file", "The file is empty");
    const contentType = sniff(data);
    if (!contentType) throw new AppError(415, "unsupported_file_type", "Only JPEG, PNG, WebP, HEIC images and PDF files can be attached");
    const [{ n }] = (await this.db.select({ n: count() }).from(attachments).where(eq(attachments.transactionId, transactionId))) as [{ n: number }];
    if (n >= MAX_PER_TRANSACTION) throw unprocessable("too_many_attachments", `A transaction can have at most ${MAX_PER_TRANSACTION} attachments`);
    const storageKey = `${userId}/${randomUUID()}`;
    await this.storage.put(storageKey, data);
    try {
      const [row] = await this.db.insert(attachments).values({ userId, transactionId, fileName: cleanName(fileName), contentType, sizeBytes: data.length, storageKey }).returning();
      return pub(row!);
    } catch (e) { await this.storage.delete(storageKey).catch(() => {}); throw e; }
  }
  async file(userId: string, id: string) {
    const [a] = await this.db.select().from(attachments).where(and(eq(attachments.id, id), eq(attachments.userId, userId)));
    if (!a) throw notFound("Attachment");
    return { meta: a, data: await this.storage.get(a.storageKey) };
  }
  async remove(userId: string, id: string) {
    const [a] = await this.db.delete(attachments).where(and(eq(attachments.id, id), eq(attachments.userId, userId))).returning();
    if (!a) throw notFound("Attachment");
    await this.storage.delete(a.storageKey).catch(() => {});
  }
  /** Used when a transaction is deleted: rows and bytes go with it. */
  async removeForTransactions(userId: string, transactionIds: string[]) {
    for (const id of transactionIds) {
      const rows = await this.db.delete(attachments).where(and(eq(attachments.transactionId, id), eq(attachments.userId, userId))).returning({ key: attachments.storageKey });
      for (const r of rows) await this.storage.delete(r.key).catch(() => {});
    }
  }
}

@Controller()
export class AttachmentsController {
  constructor(@Inject(AttachmentsService) private readonly svc: AttachmentsService) {}

  @Get("transactions/:id/attachments") async list(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { return { data: await this.svc.list(u, id) }; }

  @Post("transactions/:id/attachments")
  async upload(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: FastifyRequest) {
    if (!req.isMultipart()) throw new AppError(415, "multipart_required", "Send the file as multipart/form-data in a field named `file`");
    let part;
    try { part = await req.file({ limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } }); }
    catch { throw new AppError(400, "invalid_upload", "Could not read the upload"); }
    if (!part || part.fieldname !== "file") throw new AppError(400, "file_required", "Send the file in a field named `file`");
    const data = await part.toBuffer().catch(() => { throw new AppError(413, "file_too_large", "Files can be at most 10 MB"); });
    if (part.file.truncated) throw new AppError(413, "file_too_large", "Files can be at most 10 MB");
    return { data: await this.svc.upload(u, id, part.filename, data) };
  }

  @Get("attachments/:id/file")
  async download(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: FastifyReply) {
    const { meta, data } = await this.svc.file(u, id);
    const inline = meta.contentType !== "image/heic"; // browsers can't show HEIC: download it instead
    res.header("Content-Type", meta.contentType);
    res.header("Content-Length", String(data.length));
    res.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.fileName)}`);
    res.header("Cache-Control", "private, no-store");
    res.header("X-Content-Type-Options", "nosniff");
    res.header("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    return data;
  }

  @Delete("attachments/:id") @HttpCode(204) async remove(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { await this.svc.remove(u, id); }
}
