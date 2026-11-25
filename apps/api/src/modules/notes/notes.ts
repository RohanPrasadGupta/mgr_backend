import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { createNoteSchema, listNotesSchema, updateNoteSchema, type CreateNoteInput, type UpdateNoteInput } from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { notes } from "../../db/schema";
import { notFound } from "../../common/errors";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";

@Injectable()
export class NotesService {
  constructor(@Inject(DB) private readonly db: Db) {}
  list(userId: string, q?: string) {
    const like = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : undefined;
    return this.db.select().from(notes).where(and(eq(notes.userId, userId), like ? or(ilike(notes.title, like), ilike(notes.body, like)) : undefined)).orderBy(desc(notes.pinned), desc(notes.updatedAt));
  }
  async create(userId: string, b: CreateNoteInput) { const [row] = await this.db.insert(notes).values({ userId, ...b }).returning(); return row!; }
  async update(userId: string, id: string, b: UpdateNoteInput) {
    const [row] = await this.db.update(notes).set({ ...b, updatedAt: new Date() }).where(and(eq(notes.id, id), eq(notes.userId, userId))).returning();
    if (!row) throw notFound("Note");
    return row;
  }
  async remove(userId: string, id: string) {
    const [row] = await this.db.delete(notes).where(and(eq(notes.id, id), eq(notes.userId, userId))).returning({ id: notes.id });
    if (!row) throw notFound("Note");
  }
}

@Controller("notes")
export class NotesController {
  constructor(@Inject(NotesService) private readonly svc: NotesService) {}
  @Get() async list(@UserId() u: string, @Query(new ZodPipe(listNotesSchema)) q: { q?: string }) { return { data: await this.svc.list(u, q.q) }; }
  @Post() async create(@UserId() u: string, @Body(new ZodPipe(createNoteSchema)) b: CreateNoteInput) { return { data: await this.svc.create(u, b) }; }
  @Patch(":id") async update(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(updateNoteSchema)) b: UpdateNoteInput) { return { data: await this.svc.update(u, id, b) }; }
  @Delete(":id") @HttpCode(204) async remove(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { await this.svc.remove(u, id); }
}
