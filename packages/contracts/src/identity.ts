import { z } from "zod";

export const identityEmailSchema = z.string()
  .trim()
  .max(254)
  .email()
  .transform((value) => value.toLowerCase());

export const identityPasswordSchema = z.string().min(10).max(128);

export const identityDisplayNameSchema = z.string().trim().min(1).max(48);

export const identityRegisterRequestSchema = z.object({
  email: identityEmailSchema,
  password: identityPasswordSchema,
  displayName: identityDisplayNameSchema.optional(),
}).strict();
export type IdentityRegisterRequest = z.infer<typeof identityRegisterRequestSchema>;

export const identityLoginRequestSchema = z.object({
  email: identityEmailSchema,
  password: z.string().min(1).max(128),
}).strict();
export type IdentityLoginRequest = z.infer<typeof identityLoginRequestSchema>;

export const publicIdentityUserSchema = z.object({
  id: z.string().uuid(),
  email: identityEmailSchema,
  displayName: identityDisplayNameSchema,
  createdAt: z.string().datetime({ offset: true }),
});
export type PublicIdentityUser = z.infer<typeof publicIdentityUserSchema>;

export const identitySessionSchema = z.object({
  user: publicIdentityUserSchema,
  expiresAt: z.string().datetime({ offset: true }),
});
export type IdentitySession = z.infer<typeof identitySessionSchema>;

export const identityRegistrationModeSchema = z.enum(["native", "external", "disabled"]);

/** 本地开发测试账号：API 非生产环境默认启用（devTestAccount capability 为真时，
    登录页据此提供一键登录）；生产环境的服务端不存在这条登录通道。 */
export const DEV_TEST_ACCOUNT_EMAIL = "admin";
export const DEV_TEST_ACCOUNT_PASSWORD = "123456";

export const identityCapabilitiesSchema = z.object({
  available: z.boolean(),
  registration: identityRegistrationModeSchema,
  registrationUrl: z.string().url().nullable(),
  passwordResetUrl: z.string().url().nullable(),
  /** 本地开发测试账号可用（admin/123456）。生产环境的服务端不会置位。 */
  devTestAccount: z.boolean().optional(),
});
export type IdentityCapabilities = z.infer<typeof identityCapabilitiesSchema>;

export const identitySessionResponseSchema = z.object({
  ok: z.literal(true),
  data: identitySessionSchema,
  capabilities: identityCapabilitiesSchema.optional(),
});

export const identityRegistrationResponseSchema = z.discriminatedUnion("status", [
  z.object({
    ok: z.literal(true),
    status: z.literal("authenticated"),
    data: identitySessionSchema,
    capabilities: identityCapabilitiesSchema.optional(),
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal("verification_required"),
    data: z.object({ email: identityEmailSchema }).strict(),
    capabilities: identityCapabilitiesSchema.optional(),
  }),
]);
export type IdentityRegistrationResponse = z.infer<typeof identityRegistrationResponseSchema>;

export const identitySessionStateResponseSchema = z.object({
  ok: z.literal(true),
  data: identitySessionSchema.nullable(),
  capabilities: identityCapabilitiesSchema.optional(),
});

export const identityLogoutResponseSchema = z.object({
  ok: z.literal(true),
});
