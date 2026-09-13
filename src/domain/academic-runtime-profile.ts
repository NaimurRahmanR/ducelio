import { z } from "zod";
import { runtimeBudgetPolicySchema } from "./academic-runtime";

// A runtime/model profile is the ONLY server-owned source of a provider
// endpoint/adapter kind and a budget policy. Course-package and agent
// configuration may only reference a profile by this bounded identifier
// string; they can never define a provider endpoint, credential or budget
// themselves (see src/domain/academic-agent-config.ts's modelProfileRef and
// src/server/academic-runtime/profile-registry.ts's code-only registry). A
// profile reference that does not resolve in the registry fails closed
// before any provider call, regardless of what a course or agent
// configuration proposed.
export const runtimeProfileRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/);
export type RuntimeProfileRef = z.infer<typeof runtimeProfileRefSchema>;

// adapterKind is provider-neutral vocabulary, not a vendor choice: HTTP_JSON
// names a transport shape (see src/server/academic-runtime/provider.ts),
// not a specific company's API. TEST_DETERMINISTIC profiles never resolve a
// production adapter (src/server/academic-runtime/profile-registry.ts);
// they exist only so tests can supply a deterministic fake adapter for an
// otherwise-real profile resolution path.
export const runtimeAdapterKindSchema = z.enum([
  "HTTP_JSON",
  "TEST_DETERMINISTIC",
]);
export type RuntimeAdapterKind = z.infer<typeof runtimeAdapterKindSchema>;

export const runtimeProfileSchema = z.strictObject({
  ref: runtimeProfileRefSchema,
  adapterKind: runtimeAdapterKindSchema,
  budgetPolicy: runtimeBudgetPolicySchema,
});
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;
