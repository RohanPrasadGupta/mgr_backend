import { z } from "zod";
import { currencyCode, timeZone } from "./common";

export const registerSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(80),
  baseCurrency: currencyCode.optional(),
  timezone: timeZone.optional(),
});
export const loginSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(1).max(128),
});
export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });
export const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    baseCurrency: currencyCode,
    timezone: timeZone,
    locale: z.string().min(2).max(10),
    weekStart: z.number().int().min(0).max(6),
  })
  .partial();
/** Account deletion re-authenticates with the password; it is irreversible. */
export const deleteAccountSchema = z.object({ password: z.string().min(1).max(128) });
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
