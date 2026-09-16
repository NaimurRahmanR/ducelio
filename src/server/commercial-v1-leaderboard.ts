import "server-only";
import { z } from "zod";
import {
  publishCommercialV1LeaderboardSnapshotInputSchema,
  commercialV1LeaderboardResultSchema,
} from "@/domain/commercial-v1-leaderboard";
import { requireActor } from "./identity";
import { createSupabase } from "./supabase";

// Governed admin surface: only ACADEMIC_ADMIN/PLATFORM_ADMIN may publish a
// leaderboard snapshot (course_activation_private.require_admin() inside
// the RPC). No caller-supplied score/rank/result-revision field exists on
// this input schema.
export async function publishCommercialV1LeaderboardSnapshot(input: unknown) {
  const payload =
    publishCommercialV1LeaderboardSnapshotInputSchema.parse(input);
  await requireActor("admin");
  const client = await createSupabase();
  const { data, error } = await client.rpc(
    "publish_commercial_v1_leaderboard_snapshot",
    { p_activation_id: payload.activationId, p_reason: payload.reason },
  );
  if (error)
    throw new Error("The leaderboard snapshot could not be published.");
  return z.uuid().parse(data);
}

// Bounded projection: self-scoped for the owning learner, or an admin
// viewing on the enrolment's own behalf -- mirrors getCommercialV1CourseProgress's
// exact p_enrolment_id self-or-admin pattern. Never exposes protected
// content; peers are shown only rank/score/a pseudonymous label within the
// SAME cohort's published snapshot.
export async function getCommercialV1Leaderboard(enrolmentId: unknown) {
  const id = z.uuid().parse(enrolmentId);
  await requireActor();
  const client = await createSupabase();
  const { data, error } = await client.rpc("get_commercial_v1_leaderboard", {
    p_enrolment_id: id,
  });
  if (error) throw new Error("The leaderboard could not be loaded.");
  return commercialV1LeaderboardResultSchema.parse(data);
}
