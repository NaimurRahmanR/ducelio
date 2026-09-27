import { NextResponse } from "next/server";
import { z } from "zod";
import { signInSchema } from "@/domain/auth";
import { AccessDenied, AuthenticationRequired } from "@/domain/policy";
import { createSupabase } from "@/server/supabase";
import {
  acceptanceAppDriverRequestAllowed,
  acceptanceEnvironmentMatches,
} from "@/server/acceptance-app-driver";
import { submitControlledAssessmentAndGrade } from "@/server/commercial-v1-submission-grading";
import { recoverExaminerTarget } from "@/server/commercial-v1-examiner-recovery/operations";
import { regradeControlledAssessment } from "@/server/commercial-v1-examiner-regrade";

// ============================================================================
// ACCEPTANCE-ONLY. Not a product API. See src/server/acceptance-app-driver.ts
// for the fail-closed gate (404 unless every acceptance condition holds) and
// scripts/acceptance/examiner-app.mjs for its only caller.
//
// Each operation is a thin HTTP hop into an EXISTING production entrypoint,
// executed inside a real Next.js request so identity resolves exactly as it
// does for the product (Supabase SSR session cookies ->
// getAuthenticatedActor()). This file never signs anything, never reads a
// controller key, and never builds a canonical message: every HMAC is
// produced by src/server/commercial-v1-examiner-*/authority.ts, reached only
// through the same entrypoints the learner/admin product surfaces call.
//
// Input is strictly the bounded business input each entrypoint already
// accepts (attemptId; sourceExecutionId+reason; resultRevisionId+reason).
// Every schema is a strictObject, so a caller-supplied actor/student id,
// capability, target kind, provider, model, profile, marks or revision
// number is rejected with 400 before any server function runs. Responses
// carry only statuses and identifiers -- never protected assessment content.
// ============================================================================

export const dynamic = "force-dynamic";

const reason = z.string().max(300);
const requestSchema = z.discriminatedUnion("operation", [
  // Establishes a genuine Supabase Auth session through the normal SSR
  // cookie adapter (the same signInWithPassword + confirmed-email rule as
  // src/app/auth/actions.ts's login). Credentials are never echoed and no
  // session token is ever returned in the body.
  z.strictObject({
    operation: z.literal("SIGN_IN"),
    email: z.string().max(254),
    password: z.string().max(128),
  }),
  // Learner: src/server/commercial-v1-submission-grading.ts -- the same
  // composition finishControlledAssessment (src/app/student/actions.ts)
  // uses: submit_assessment_attempt, then gradeControlledAssessmentAttempt.
  z.strictObject({
    operation: z.literal("SUBMIT_AND_GRADE_ASSESSMENT"),
    attemptId: z.uuid(),
  }),
  // Institutional admin: the same composition
  // src/app/admin/activation/recovery/actions.ts reaches.
  z.strictObject({
    operation: z.literal("RECOVER_EXAMINER_TARGET"),
    sourceExecutionId: z.uuid(),
    reason,
  }),
  // Institutional admin: the existing regrade entrypoint.
  z.strictObject({
    operation: z.literal("REGRADE_CONTROLLED_ASSESSMENT"),
    resultRevisionId: z.uuid(),
    reason,
  }),
]);

const NO_STORE = { "Cache-Control": "private, no-store" };
function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}
function notFound() {
  return new NextResponse(null, { status: 404, headers: NO_STORE });
}

export async function POST(request: Request) {
  // Includes the per-request attestation that provider traffic in THIS
  // process routes through the driver's marked loopback redirect -- before
  // the body is read, anyone is signed in or any operation runs.
  if (!(await acceptanceAppDriverRequestAllowed(request))) return notFound();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "INVALID_REQUEST" });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "INVALID_REQUEST" });
  const command = parsed.data;

  const client = await createSupabase();
  if (command.operation === "SIGN_IN") {
    const credentials = signInSchema.safeParse({
      email: command.email,
      password: command.password,
    });
    if (!credentials.success) return json(400, { error: "INVALID_REQUEST" });
    const { data, error } = await client.auth.signInWithPassword(
      credentials.data,
    );
    if (error || !data.user?.email_confirmed_at) {
      await client.auth.signOut().catch(() => {});
      return json(401, { error: "AUTHENTICATION_FAILED" });
    }
    if (!(await acceptanceEnvironmentMatches(client))) {
      await client.auth.signOut().catch(() => {});
      return notFound();
    }
    return json(200, { ok: true });
  }

  // Every other operation runs as the caller's EXISTING real session, and
  // only once that session proves it belongs to the deliberately
  // provisioned acceptance environment.
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return json(401, { error: "AUTHENTICATION_REQUIRED" });
  if (!(await acceptanceEnvironmentMatches(client))) return notFound();

  try {
    switch (command.operation) {
      case "SUBMIT_AND_GRADE_ASSESSMENT": {
        const result = await submitControlledAssessmentAndGrade(
          command.attemptId,
        );
        return json(200, {
          ok: true,
          result: { attemptId: result.attemptId, grading: result.grading },
        });
      }
      case "RECOVER_EXAMINER_TARGET": {
        const result = await recoverExaminerTarget({
          sourceExecutionId: command.sourceExecutionId,
          reason: command.reason,
        });
        return json(200, {
          ok: true,
          result: {
            status: result.status,
            resultRevisionId:
              "resultRevisionId" in result ? result.resultRevisionId : null,
          },
        });
      }
      case "REGRADE_CONTROLLED_ASSESSMENT": {
        const result = await regradeControlledAssessment({
          resultRevisionId: command.resultRevisionId,
          reason: command.reason,
        });
        return json(200, {
          ok: true,
          result: {
            status: result.status,
            executionId: "executionId" in result ? result.executionId : null,
            resultRevisionId:
              "resultRevisionId" in result ? result.resultRevisionId : null,
          },
        });
      }
    }
  } catch (error) {
    if (error instanceof AuthenticationRequired)
      return json(401, { error: "AUTHENTICATION_REQUIRED" });
    if (error instanceof AccessDenied) return json(403, { error: "FORBIDDEN" });
    return json(500, { error: "OPERATION_FAILED" });
  }
}
