export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { recordAutoFixResult, type AutoFixOutcome } from "@/lib/scheduledJobs";

const AUTO_FIX_OUTCOMES: AutoFixOutcome[] = [
  "fixed_and_merged",
  "needs_human",
  "no_action_needed",
];

const authorized = (request: Request) => {
  const secret = process.env.AUTO_FIX_SYNC_SECRET;
  if (!secret || secret.length < 32) return false;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(secret).digest(),
    createHash("sha256").update(provided).digest()
  );
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const runId = typeof body?.runId === "string" ? body.runId : "";
  const outcome = AUTO_FIX_OUTCOMES.includes(body?.outcome)
    ? (body.outcome as AutoFixOutcome)
    : null;
  const detail = typeof body?.detail === "string" ? body.detail : undefined;
  const jobKey = typeof body?.jobKey === "string" ? body.jobKey : "unknown";

  if (!runId || !outcome) {
    return NextResponse.json(
      { error: "runId and a valid outcome are required." },
      { status: 400 }
    );
  }

  await recordAutoFixResult({ runId, outcome, detail });

  if (outcome === "needs_human") {
    await reportOperationalIncident({
      code: "CRON_AUTO_FIX_NEEDS_HUMAN",
      title: `Auto-fix could not resolve ${jobKey} failure`,
      error: detail || "Auto-fix pipeline could not produce a safe, passing fix.",
      severity: "warning",
      context: { component: "cron_auto_fix", jobKey, runId },
    }).catch(() => undefined);
  }

  return NextResponse.json({ recorded: true });
}
