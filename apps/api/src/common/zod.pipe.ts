import { Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { z } from "zod";
import { AppError } from "./errors";

@Injectable()
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) throw new AppError(400, "validation_error", "Invalid request", z.flattenError(r.error));
    return r.data;
  }
}
