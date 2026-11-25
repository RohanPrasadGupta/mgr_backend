import { z } from "zod";
import { currencyCode, timeZone } from "./common";

/** Normalise before validating, so " Me@Example.com " signs in as me@example.com. */
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const registerSchema = z.object({
  email,
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(80),
  baseCurrency: currencyCode.optional(),
  timezone: timeZone.optional(),
});
export const loginSchema = z.object({
  email,
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
export const forgotPasswordSchema = z.object({ email });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: z.string().min(8).max(128) });
export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });
/** Signed-in password change: the current password re-authenticates. Other sessions are signed out. */
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(8).max(128) });
/** Account deletion re-authenticates with the password; it is irreversible. */
export const deleteAccountSchema = z.object({ password: z.string().min(1).max(128) });
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
