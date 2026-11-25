import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { createTagSchema, updateTagSchema, type CreateTagInput, type UpdateTagInput } from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { tags } from "../../db/schema";
import { conflict, isUniqueViolation, notFound } from "../../common/errors";
import { ZodPipe } from "../../common/zod.pipe";
import { UserId } from "../auth/auth.guard";

const usage = sql<number>`(select count(*)::int from transaction_tags tt join transactions t on t.id = tt.transaction_id where tt.tag_id = "tags"."id" and t.deleted_at is null)`; // qualified on purpose: a bare ${tags.id} renders as "id", which would bind to transactions.id

@Injectable()
export class TagsService {
  constructor(@Inject(DB) private readonly db: Db) {}
  list(userId: string) {
    return this.db.select({ id: tags.id, userId: tags.userId, name: tags.name, color: tags.color, createdAt: tags.createdAt, usageCount: usage }).from(tags).where(eq(tags.userId, userId)).orderBy(sql`lower(${tags.name})`);
  }
  private async get(userId: string, id: string) {
    const row = (await this.list(userId)).find((t) => t.id === id);
    if (!row) throw notFound("Tag");
    return row;
  }
  async create(userId: string, b: CreateTagInput) {
    try {
      const [row] = await this.db.insert(tags).values({ userId, name: b.name, color: b.color }).returning();
      return { ...row!, usageCount: 0 };
    } catch (e) { if (isUniqueViolation(e)) throw conflict("tag_exists", `A tag named "${b.name}" already exists`); throw e; }
  }
  async update(userId: string, id: string, b: UpdateTagInput) {
    if (Object.keys(b).length) {
      try {
        const [row] = await this.db.update(tags).set(b).where(and(eq(tags.id, id), eq(tags.userId, userId))).returning({ id: tags.id });
        if (!row) throw notFound("Tag");
      } catch (e) { if (isUniqueViolation(e)) throw conflict("tag_exists", `A tag named "${b.name}" already exists`); throw e; }
    }
    return this.get(userId, id);
  }
  async remove(userId: string, id: string) {
    const [row] = await this.db.delete(tags).where(and(eq(tags.id, id), eq(tags.userId, userId))).returning({ id: tags.id });
    if (!row) throw notFound("Tag");
  }
}

@Controller("tags")
export class TagsController {
  constructor(@Inject(TagsService) private readonly svc: TagsService) {}
  @Get() async list(@UserId() u: string) { return { data: await this.svc.list(u) }; }
  @Post() async create(@UserId() u: string, @Body(new ZodPipe(createTagSchema)) b: CreateTagInput) { return { data: await this.svc.create(u, b) }; }
  @Patch(":id") async update(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(updateTagSchema)) b: UpdateTagInput) { return { data: await this.svc.update(u, id, b) }; }
  @Delete(":id") @HttpCode(204) async remove(@UserId() u: string, @Param("id", ParseUUIDPipe) id: string) { await this.svc.remove(u, id); }
}
