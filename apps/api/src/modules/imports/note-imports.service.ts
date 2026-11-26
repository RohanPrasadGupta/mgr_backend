import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { importNoteRowSchema, parseInTimeZone } from "@moneymgr/shared";
import { DB, type Db } from "../../db/db";
import { notes, users } from "../../db/schema";
import { notFound } from "../../common/errors";

export interface NoteImportReport { dryRun: boolean; total: number; imported: number; duplicates: number; invalid: { row: number; reason: string }[] }

/** A note is a duplicate when the user already has one with the same title and body (so re-importing a file adds nothing). */
const sameNote = (title: string, body: string) => `${title}\u0000${body}`;

@Injectable()
export class NoteImportsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async importNotes(userId: string, rawRows: unknown[], dryRun: boolean): Promise<NoteImportReport> {
    const [user] = await this.db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId));
    if (!user) throw notFound("User");
    const report: NoteImportReport = { dryRun, total: rawRows.length, imported: 0, duplicates: 0, invalid: [] };

    const existing = await this.db.select({ title: notes.title, body: notes.body }).from(notes).where(eq(notes.userId, userId));
    const seen = new Set(existing.map((n) => sameNote(n.title, n.body)));
    const values: (typeof notes.$inferInsert)[] = [];
    rawRows.forEach((raw, i) => {
      // v1 notes call the text "content"; take either name.
      const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const p = importNoteRowSchema.safeParse({ ...r, body: r["body"] ?? r["content"] ?? "" });
      if (!p.success) return void report.invalid.push({ row: i + 1, reason: p.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ") });
      const at = p.data.date ? parseInTimeZone(p.data.date, user.timezone) : new Date();
      if (!at) return void report.invalid.push({ row: i + 1, reason: `date: unrecognised format "${p.data.date}"` });
      const key = sameNote(p.data.title, p.data.body);
      if (seen.has(key)) return void report.duplicates++;
      seen.add(key);
      values.push({ userId, title: p.data.title, body: p.data.body, createdAt: at, updatedAt: at });
    });

    if (!dryRun && values.length) {
      await this.db.transaction(async (tx) => {
        for (let i = 0; i < values.length; i += 1000) await tx.insert(notes).values(values.slice(i, i + 1000));
      });
    }
    report.imported = values.length;
    return report;
  }
}
