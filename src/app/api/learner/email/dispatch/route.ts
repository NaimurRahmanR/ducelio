import { NextResponse, type NextRequest } from "next/server";
import { learnerServicesConfig } from "@/lib/env";
import {
  cronAuthorized,
  runLearnerEmailDispatch,
} from "@/server/learner-email";

// Scheduled outbox dispatch. Requires the shared CRON_SECRET; returns counts
// only. With no email provider configured nothing is claimed and every
// message stays QUEUED (reported to learners as delivery pending).
async function dispatch(request: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  if (!cronAuthorized(request.headers, learnerServicesConfig().cronSecret))
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers },
    );
  try {
    return NextResponse.json(await runLearnerEmailDispatch(), { headers });
  } catch {
    return NextResponse.json(
      { error: "Unavailable" },
      { status: 503, headers },
    );
  }
}

export const GET = dispatch;
export const POST = dispatch;
