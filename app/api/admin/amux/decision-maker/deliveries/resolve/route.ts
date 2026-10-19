export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  AMUX_DB_BOUNDARIES,
  AmuxDbBoundaryError,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import {
  DecisionMakerJudgmentWriteError,
  resolveDecisionMakerDeliveryUnknown,
} from "@/lib/amux/decisionMakerJudgmentStore";

/**
 * A person records what became of a confirmed answer whose delivery is unknown
 * (docs/policy/amux-decision-maker.md §2-7, §9): `delivered` or
 * `not_delivered`, once, after they checked the worker's session in AMUX.
 *
 * `ops:write` and a recent step-up, checked before the body is read, like the
 * judgment route. The store writes the person's audit and the event in one
 * transaction (resolveDecisionMakerDeliveryUnknown); it refuses a request
 * whose delivery is not unknown or is already resolved, and says why. It sends
 * nothing to a worker: an answer that was not delivered is the operator's to
 * give directly. An unknown outcome is said, never retried.
 */

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStoreHeaders["Cache-Control"]);
  return response;
};

const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });

const bodySchema = z
  .object({
    requestId: z.string().max(36),
    outcome: z.string().max(16),
  })
  .strict();

const BODY_LIMIT_BYTES = 1024;

export async function POST(request: Request) {
  return withAmuxRouteBudget(async () => {
    try {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id || !isAdminSession(session)) return notFound();
      if (!hasAdminPermission(session, "ops:write")) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
      }
      await assertRecentAdminAuthentication(session);
      await consumeApiRateLimit(request, session.user.id, "admin-amux-decision-maker-delivery-resolve", {
        minute: 10,
        day: 200,
      });
      const body = await readLimitedJson(request, BODY_LIMIT_BYTES, bodySchema);
      const result = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerDeliveryResolve, (tx) =>
        resolveDecisionMakerDeliveryUnknown(tx, { session, request, requestId: body.requestId, outcome: body.outcome }),
      );
      if (!result.recorded) {
        return NextResponse.json(
          { error: "resolution_refused", reason: result.reason },
          { status: 409, headers: noStoreHeaders },
        );
      }
      return NextResponse.json(
        { recorded: true, outcome: result.outcome, createdAt: result.event.createdAt },
        { headers: noStoreHeaders },
      );
    } catch (error) {
      const approvalResponse = adminApprovalErrorResponse(error);
      if (approvalResponse) return withNoStore(approvalResponse);
      if (error instanceof DecisionMakerJudgmentWriteError) {
        if (error.code === "no_operator") return notFound();
        if (error.code === "invalid_input") {
          return NextResponse.json({ error: "invalid_resolution" }, { status: 400, headers: noStoreHeaders });
        }
      }
      const security = apiSecurityResponse(error);
      if (security) return withNoStore(security);
      const code =
        error instanceof AmuxDbBoundaryError
          ? error.code
          : error instanceof DecisionMakerJudgmentWriteError
            ? error.code
            : null;
      console.error(JSON.stringify({ subsystem: "amux", event: "decision_maker_delivery_resolve_failed", code }));
      return NextResponse.json(
        { error: code === "AMUX_DB_OUTCOME_UNKNOWN" ? "outcome_unknown" : "resolution_failed" },
        { status: 503, headers: noStoreHeaders },
      );
    }
  });
}
