export const dynamic = "force-dynamic";
// Longer than the comments service's whole run: it is the service that stops a
// run, not the platform.
export const maxDuration = 300;

import { NextResponse } from "next/server";

import { buildZernioCommentsQueryFromEnv } from "@/app/api/_marketing/zernioCommentsQuery";
import { commentsMonitorEnabled } from "@/lib/marketingCommentsMonitorHealth";
import { marketingCommentsMonitorOperations } from "@/lib/marketingCommentsMonitorOperations";
import {
  MARKETING_COMMENTS_MONITOR_MAX_BODY_BYTES,
  answerMarketingCommentsMonitorRequest,
  marketingCommentsMonitorRequestSchema,
} from "@/lib/marketingCommentsMonitorRequest";
import {
  marketingGeneratorAuthorized,
  marketingGeneratorSecret,
  parseMarketingGeneratorJson,
  readMarketingGeneratorBody,
} from "@/lib/marketingGeneratorAuth";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";

// The comment monitor's two steps (marketing S4d; docs/policy/marketing-automation.md §12.1).
//
// The comments service holds the marketing LLM key and no database or posting
// credential; this route holds those and no LLM key. `collect` hands the
// service the new comment bodies -- text only -- and `judge` takes back one
// verdict per body and runs the monitor here (lib/marketingCommentsMonitorRequest.ts).
// The generator's secret, by the generator's rule: the service is the
// generator's sibling and the bearer of the same key.
//
// Off is off: with MARKETING_COMMENTS_MONITOR_ENABLED not true, or the marketing
// kill switch set, the answer is `off` before the database or the posting tool
// is touched.

/** One Zernio page request; a slower one is unavailable and its post unread. */
const ZERNIO_CALL_BUDGET_MS = 10_000;

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request) {
  const secret = marketingGeneratorSecret();
  if (!secret || !marketingGeneratorAuthorized(request, secret)) {
    return json({ error: "Unauthorized" }, 401);
  }
  const raw = await readMarketingGeneratorBody(request, MARKETING_COMMENTS_MONITOR_MAX_BODY_BYTES);
  if (raw === null) return json({ code: "body_too_large" }, 413);
  const parsed = marketingCommentsMonitorRequestSchema.safeParse(parseMarketingGeneratorJson(raw));
  if (!parsed.success) return json({ code: "invalid_request" }, 400);

  if (!commentsMonitorEnabled(process.env)) return json({ status: "off" }, 200);
  const comments = buildZernioCommentsQueryFromEnv(ZERNIO_CALL_BUDGET_MS);
  if (comments === null) return json({ code: "no_credential" }, 503);

  try {
    const answer = await answerMarketingCommentsMonitorRequest(parsed.data, {
      env: process.env,
      enabled: commentsMonitorEnabled,
      now: () => new Date(),
      fetchComments: (post) => comments.fetchComments(post.externalPostId, post.externalAccountRef),
      operations: marketingCommentsMonitorOperations(prisma),
    });
    return json(answer.body, answer.status);
  } catch (error) {
    // The database, not a comment: the monitor's own reads failed. No body,
    // post or account reaches the incident.
    void reportOperationalIncident({
      code: "MARKETING_COMMENTS_MONITOR_FAILED",
      title: "Marketing comment monitor step failed",
      error,
      severity: "error",
      cooldownMs: 30 * 60 * 1_000,
      context: { component: "marketing-comments-monitor", action: parsed.data.action },
    }).catch((reportError: unknown) => {
      console.error("Marketing comment monitor incident could not be reported:", reportError);
    });
    return json({ code: "monitor_failed" }, 500);
  }
}
