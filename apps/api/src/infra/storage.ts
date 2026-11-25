import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Blob storage for attachments. Local disk today; the S3/MinIO implementation plugs in behind the same interface (P6). */
export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Remove everything stored for a user (account deletion). */
  deleteUser(userId: string): Promise<void>;
}
export const STORAGE = Symbol("STORAGE");

export class DiskStorage implements Storage {
  private readonly root: string;
  constructor(dir: string) { this.root = resolve(dir); }
  /** Keys are generated server-side (`userId/uuid`), but refuse anything that could escape the root anyway. */
  private path(key: string) {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)) throw new Error("invalid storage key");
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error("invalid storage key");
    return p;
  }
  async put(key: string, data: Buffer) { const p = this.path(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, data, { mode: 0o600 }); }
  get(key: string) { return readFile(this.path(key)); }
  async delete(key: string) { await rm(this.path(key), { force: true }); }
  async deleteUser(userId: string) {
    if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error("invalid user id");
    await rm(join(this.root, userId), { recursive: true, force: true });
  }
}
