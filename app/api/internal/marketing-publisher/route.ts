export const dynamic = "force-dynamic";
// Longer than the run deadline the service enforces, so it is the service that
// stops a run, not the platform.
export const maxDuration = 300;

import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import { resolveMarketingPublishAdapter } from "@/lib/marketingPublishAdapter";
import {
  finishMarketingPublisherRun,
  heartbeatMarketingPublisherRun,
  startMarketingPublisherRun,
} from "@/lib/marketingPublisherRun";
import {
  MARKETING_PUBLISHER_TIMING,
  marketingPublisherDeadlineProblem,
  marketingPublisherRequestSchema,
} from "@/lib/marketingPublisherRunCore";
import { prisma } from "@/lib/prisma";

// The marketing publisher's app route (S2 plan, S2d1).
//
// The Railway service `Marketing Publisher` calls this every five minutes with
// `{ runId, deadline }` and a bearer secret. The service holds no database
// credential and no platform credential; it is a clock and an HTTP client, and
// this route is where the work happens.
//
// What the work is, in this build: nothing yet, on purpose. There is no
// publishing adapter until S2d2, so a run opens its row, establishes that there
// is nothing it can do and why, and closes. That is still worth running every
// five minutes -- it proves the service, the secret, the route, the run row and
// its deadline trigger end to end before anything is able to publish, and the
// silence monitor learns what a healthy run looks like.

/**
 * Only `MARKETING_PUBLISH_SECRET`. Not the maintenance secret as a fallback, the
 * way older internal routes do: the publisher is the one service that will be
 * able to post in the company's name, and a secret shared with the cleanup cron
 * is a secret whose leak reaches that.
 */
const authorized = (request: Request) => {
  const secret = process.env.MARKETING_PUBLISH_SECRET;
  if (!secret || secret.length < 32) return false;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(secret).digest(),
    createHash("sha256").update(provided).digest(),
  );
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = marketingPublisherRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "The request must be exactly { runId, deadline }", code: "invalid_request" },
      { status: 400 },
    );
  }
  const runId = parsed.data.runId;
  const deadlineAt = new Date(parsed.data.deadline);

  const problem = marketingPublisherDeadlineProblem(
    new Date(),
    deadlineAt,
    MARKETING_PUBLISHER_TIMING,
  );
  if (problem) {
    // Refused before a row exists. The database's rule that a late run is not
    // a success is only as strong as the deadline it is measured against, and
    // a deadline a year away would make every run punctual.
    return NextResponse.json(
      { error: "The deadline is not one this route accepts", code: problem },
      { status: 400 },
    );
  }

  const started = await startMarketingPublisherRun(prisma, { runId, deadlineAt });
  if (!started.started) {
    // A duplicate id is never a second run. A retry of the same request while
    // it runs is answered without doing the work again; anything else is a
    // conflict.
    return NextResponse.json(
      { runId, code: started.reason },
      { status: started.reason === "already_running" ? 202 : 409 },
    );
  }

  try {
    const skipped = whyNothingToDo();
    await heartbeatMarketingPublisherRun(prisma, runId);
    const closed = await finishMarketingPublisherRun(prisma, runId, {
      status: "succeeded",
      processedCount: 0,
      result: { skipped },
    });
    return NextResponse.json({ runId, status: closed.status, skipped });
  } catch (error) {
    await finishMarketingPublisherRun(prisma, runId, {
      status: "failed",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }).catch(() => undefined);
    return NextResponse.json(
      { runId, status: "failed", code: "run_failed" },
      { status: 500 },
    );
  }
}

/**
 * Why this run has nothing to publish, in the order an operator would check.
 *
 * The kill switch first, because it is the operator's own stop and a run
 * should say it was obeyed rather than that something else happened to be
 * true as well. Then the adapter, which is the reason in every run until S2d2.
 */
function whyNothingToDo(): string {
  const killSwitch = process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
  if (typeof killSwitch === "string" && killSwitch.trim() !== "") {
    return "kill_switch";
  }
  const adapter = resolveMarketingPublishAdapter("zernio");
  if (!adapter.available) return adapter.reason;
  // Unreachable in this build: resolveMarketingPublishAdapter answers
  // unavailable for every provider until S2d2 adds one. Stated rather than
  // left to fall through, so the day it becomes reachable is a compile-visible
  // change here and not a run that silently does nothing.
  return "dispatch_not_built";
}
