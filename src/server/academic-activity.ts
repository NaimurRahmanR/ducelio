import "server-only";
import { z } from "zod";
import { requireStudentPrincipal } from "./identity";
import { createSupabase } from "./supabase";

export class AcademicActivityBlocked extends Error {
  constructor() {
    super("Academic activity is blocked");
    this.name = "AcademicActivityBlocked";
  }
}

// No caller-selected action and no cached permission grants.
export async function assertStudentExplanationAllowed() {
  await requireStudentPrincipal();
  const client = await createSupabase();
  const { data, error } = await client.rpc("assert_academic_action_allowed", {
    p_action: "EXPLAIN",
  });
  if (error?.code === "42501") throw new AcademicActivityBlocked();
  if (error || data !== true)
    throw new Error("Academic activity permissions could not be checked.");
}

export async function getStudentAcademicActivity() {
  await requireStudentPrincipal();
  const client = await createSupabase();
  const { data: state, error: stateError } = await client.rpc(
    "current_academic_activity_state",
  );
  if (stateError)
    throw new Error("Academic activity state could not be loaded.");
  const activityState = z
    .enum(["NORMAL", "CONTROLLED_ASSESSMENT_ACTIVE"])
    .parse(state);
  const { data: allowed, error } = await client.rpc("academic_action_allowed", {
    p_action: "EXPLAIN",
  });
  if (error)
    throw new Error("Academic activity permissions could not be checked.");
  const explanationAllowed = z.boolean().parse(allowed);
  // Conservative if the state changes between reads. This is only a snapshot.
  return {
    activityState,
    explanationAllowed: activityState === "NORMAL" && explanationAllowed,
  };
}
