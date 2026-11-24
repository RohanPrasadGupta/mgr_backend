import { z } from "zod";
import { isValidTimeZone } from "../dates";

export const uuid = z.string().uuid();
export const currencyCode = z.string().length(3).transform((s) => s.toUpperCase());
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export const timeZone = z.string().refine(isValidTimeZone, "invalid IANA timezone");
export const amountMinor = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const kindEnum = z.enum(["income", "expense"]);
