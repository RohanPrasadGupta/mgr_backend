import { z } from "zod";

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const page = z.coerce.number().int().min(1).max(10_000).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(25);
/** Every admin action that touches a user must say why (stored in the audit log). */
const reason = z.string().trim().min(3, "Give a reason (at least 3 characters)").max(500);

export const adminLoginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const adminMfaSchema = z.object({ mfaToken: z.string().min(20).max(2000), code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app") });
export const adminRefreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });
export const adminReasonSchema = z.object({ reason });
export const adminDeleteUserSchema = z.object({ reason, confirmEmail: email });

/** Admin accounts (owners only). Passwords are never chosen here: the API returns a one-time password to hand over. */
export const adminRoles = ["owner", "admin"] as const;
export const adminCreateSchema = z.object({ email, name: z.string().trim().min(1).max(100), role: z.enum(adminRoles).default("admin"), reason });
export const adminRoleSchema = z.object({ role: z.enum(adminRoles), reason });
/** Admin passwords are longer than customer ones: these accounts can see every user. */
export const adminChangePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12, "Use at least 12 characters").max(128) });

export const adminUserStatuses = ["all", "active", "suspended", "unverified"] as const;
export const adminUsersQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(adminUserStatuses).default("all"),
  page, pageSize,
});
export const adminAuditQuerySchema = z.object({
  userId: z.uuid().optional(),
  adminId: z.uuid().optional(),
  action: z.string().trim().max(60).optional(),
  page, pageSize,
});
/** What a support view can show. Each read is audited. */
export const supportDataKinds = ["accounts", "transactions", "categories", "budgets", "recurring", "goals", "debts", "notes", "investments", "attachments"] as const;
export type AdminCreateInput = z.infer<typeof adminCreateSchema>;
export type AdminRoleInput = z.infer<typeof adminRoleSchema>;
export type AdminChangePasswordInput = z.infer<typeof adminChangePasswordSchema>;
export type SupportDataKind = (typeof supportDataKinds)[number];

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type AdminMfaInput = z.infer<typeof adminMfaSchema>;
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;
export type AdminAuditQuery = z.infer<typeof adminAuditQuerySchema>;
