import { z } from "zod";
export const emailSchema = z.email().trim().max(254);
export const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(128, "Use no more than 128 characters.");
export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export const signUpSchema = signInSchema.extend({
  displayName: z.string().trim().min(1).max(100),
  password: passwordSchema,
});
export function safeAuthDestination(value: string | null | undefined) {
  return value === "/reset-password" ? "/reset-password" : "/student";
}
export const confirmationTypeSchema = z.enum(["email", "recovery"]);
export type AuthState = { error?: string; message?: string };
