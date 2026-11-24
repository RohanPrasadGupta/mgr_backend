import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { CreateCategoryInput, UpdateCategoryInput } from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { categories } from "../../db/schema";
import { notFound, unprocessable } from "../../common/errors";

@Injectable()
export class CategoriesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(userId: string) {
    return this.db.select().from(categories).where(and(eq(categories.userId, userId), isNull(categories.deletedAt))).orderBy(asc(categories.kind), asc(categories.name));
  }

  private async assertParent(userId: string, parentId: string, kind: "income" | "expense", selfId?: string) {
    if (parentId === selfId) throw unprocessable("invalid_parent", "A category cannot be its own parent");
    const [p] = await this.db.select().from(categories).where(and(eq(categories.id, parentId), eq(categories.userId, userId), isNull(categories.deletedAt)));
    if (!p) throw unprocessable("invalid_parent", "Parent category not found");
    if (p.kind !== kind) throw unprocessable("invalid_parent", "Parent must have the same kind");
    if (p.parentId) throw unprocessable("invalid_parent", "Only one level of sub-categories is supported");
  }

  async create(userId: string, input: CreateCategoryInput) {
    if (input.parentId) await this.assertParent(userId, input.parentId, input.kind);
    const [row] = await this.db.insert(categories).values({ ...input, userId }).returning();
    return row!;
  }

  async update(userId: string, id: string, input: UpdateCategoryInput) {
    const [cur] = await this.db.select().from(categories).where(and(eq(categories.id, id), eq(categories.userId, userId), isNull(categories.deletedAt)));
    if (!cur) throw notFound("Category");
    if (input.parentId) await this.assertParent(userId, input.parentId, cur.kind, id);
    if (Object.keys(input).length === 0) return cur;
    const [row] = await this.db.update(categories).set(input).where(eq(categories.id, id)).returning();
    return row!;
  }

  async remove(userId: string, id: string) {
    const [row] = await this.db
      .update(categories)
      .set({ deletedAt: new Date() })
      .where(and(eq(categories.id, id), eq(categories.userId, userId), isNull(categories.deletedAt)))
      .returning({ id: categories.id });
    if (!row) throw notFound("Category");
  }
}
