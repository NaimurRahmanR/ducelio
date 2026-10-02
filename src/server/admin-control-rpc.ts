import "server-only";
import type { z } from "zod";
import type { Role } from "@/domain/academy";
import {
  AdminControlError,
  isAdminRefusalCode,
} from "@/domain/admin-control-plane";
import { getAuthenticatedActor } from "./identity";
import { createSupabase } from "./supabase";

// Shared call path for migration 044's governed RPCs. The role pre-check
// only avoids a pointless round trip; the database independently derives
// the actor from the session and re-verifies authority. Bounded refusal
// codes pass through; any other failure is SERVICE_UNAVAILABLE so raw
// database text never reaches the browser.
export async function adminControlRpc<T>(
  allowed: readonly Role[],
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    const actor = await getAuthenticatedActor();
    if (!actor || !allowed.some((role) => actor.roles.includes(role)))
      throw new AdminControlError("FORBIDDEN");
    const { data, error } = await (await createSupabase()).rpc(name, args);
    if (error)
      throw new AdminControlError(
        isAdminRefusalCode(error.message)
          ? error.message
          : "SERVICE_UNAVAILABLE",
      );
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AdminControlError("SERVICE_UNAVAILABLE");
    return parsed.data;
  } catch (error) {
    if (error instanceof AdminControlError) throw error;
    throw new AdminControlError("SERVICE_UNAVAILABLE");
  }
}

export function adminInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AdminControlError("INVALID_INPUT");
  return parsed.data;
}
