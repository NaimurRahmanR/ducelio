import { z } from "zod";
import { capabilityNameSchema } from "./academic-capabilities";
import {
  agentRoleSchema,
  isCapabilityAuthorized,
  roleCapabilityCatalogue,
  type AgentRole,
} from "./academic-capability-policy";

// Role vocabulary and the capability allowlist now live in
// academic-capability-policy.ts (the single source of truth shared with
// course-package.ts and the B2 runtime). Re-exported here for every
// existing caller of this module.
export { agentRoleSchema, isCapabilityAuthorized, roleCapabilityCatalogue };
export type { AgentRole };

export const AGENT_CONFIG_POLICY = "ACADEMIC_AGENT_CONFIG_V1" as const;

export const modelProfileRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/);

export const agentConfigInputSchema = z
  .strictObject({
    programmeVersionId: z.uuid(),
    role: agentRoleSchema,
    enabled: z.boolean(),
    modelProfileRef: modelProfileRefSchema.nullable(),
    instructionalNotes: z.string().trim().max(4000).nullable(),
    capabilities: z.array(z.string().trim().min(1).max(80)).max(50),
    escalationPolicy: z.enum(["NONE", "ACADEMIC_REVIEW"]),
    reason: z.string().trim().min(5).max(300),
  })
  .superRefine((value, ctx) => {
    const allowed = new Set(roleCapabilityCatalogue[value.role]);
    value.capabilities.forEach((capability, i) => {
      if (!allowed.has(capability))
        ctx.addIssue({
          code: "custom",
          path: ["capabilities", i],
          message: `Capability is not in the reviewed ${value.role} allowlist.`,
        });
    });
    if (new Set(value.capabilities).size !== value.capabilities.length)
      ctx.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Duplicate capability name.",
      });
  });
export type AgentConfigInput = z.infer<typeof agentConfigInputSchema>;

export const agentConfigRecordSchema = z.strictObject({
  id: z.uuid(),
  programmeVersionId: z.uuid(),
  role: agentRoleSchema,
  policyVersion: z.literal(AGENT_CONFIG_POLICY),
  enabled: z.boolean(),
  modelProfileRef: modelProfileRefSchema.nullable(),
  instructionalNotes: z.string().max(4000).nullable(),
  capabilities: z.array(capabilityNameSchema.or(z.string())).max(50),
  escalationPolicy: z.enum(["NONE", "ACADEMIC_REVIEW"]),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type AgentConfigRecord = z.infer<typeof agentConfigRecordSchema>;
