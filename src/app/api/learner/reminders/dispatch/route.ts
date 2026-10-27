import { NextResponse, type NextRequest } from "next/server";
import { learnerServicesConfig } from "@/lib/env";
import { cronAuthorized } from "@/server/learner-email";
import { runActivityReminderDispatch } from "@/server/learner-push";

// Scheduled push-reminder dispatch (e.g. every minute). Requires the shared
// CRON_SECRET; returns counts only, never endpoints or learner data. With no
// VAPID or controller configuration it reports configured:false and sends
// nothing; reminders stay visible in the in-app fallback.
async function dispatch(request: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  if (!cronAuthorized(request.headers, learnerServicesConfig().cronSecret))
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers },
    );
  try {
    return NextResponse.json(await runActivityReminderDispatch(), { headers });
  } catch {
    return NextResponse.json(
      { error: "Unavailable" },
      { status: 503, headers },
    );
  }
}

export const GET = dispatch;
export const POST = dispatch;
