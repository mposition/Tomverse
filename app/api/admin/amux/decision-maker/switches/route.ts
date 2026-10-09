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
  DecisionMakerSwitchWriteError,
  readDecisionMakerSwitchesOrThrow,
  recordDecisionMakerSwitchByOperator,
} from "@/lib/amux/decisionMakerSwitchStore";

/**
 * The AMUX Decision Maker switches (docs/policy/amux-decision-maker.md §8).
 *
 * GET is the state from the newest event of each scope, for any administrator:
 * reading DM records stays open under the kill switch (§6). A row the mapping
 * does not accept reads as `null` -- the same fail-closed state the router
 * sends to the operator as `settings_unreadable`.
 *
 * POST is a person setting the kill switch `on`/`off` or an instance
 * `off`/`proposal`, and nothing else: `ops:write` and a recent step-up, checked
 * here before the body is read; a stale step-up answers 428 through
 * `adminApprovalErrorResponse`. The store writes the human audit
 * (`amux.decision.mode`, or `amux.decision.latch_release` after a system latch)
 * and the event in one transaction inside the AMUX DB boundary. When that
 * transaction's outcome is unknown the answer says so, and the caller reads
 * the state back instead of sending the change again (foundation principle 7).
 *
 * Each handler runs inside the AMUX route budget from its first line (§9:
 * `AMUX_ROUTE_BUDGET_MS`), so time spent on the session, the rate limit and
 * the body counts against it, and the boundary refuses to start a transaction
 * the route no longer has time for.
 */

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStoreHeaders["Cache-Control"]);
  return response;
};

const bodySchema = z
  .object({
    scope: z.string().max(64),
    value: z.string().max(16),
  })
  .strict();

const notFound = () =>
  NextResponse.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });

export async function GET(request: Request) {
  return withAmuxRouteBudget(async () => {
    try {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id || !isAdminSession(session)) return notFound();
      await consumeApiRateLimit(request, session.user.id, "admin-amux-decision-maker-switch-read", {
        minute: 30,
        day: 600,
      });
      const state = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerSwitchRead, (tx) =>
        readDecisionMakerSwitchesOrThrow(tx),
      );
      return NextResponse.json(
        { killSwitch: state.killSwitch, instances: state.instances },
        { headers: noStoreHeaders },
      );
    } catch (error) {
      const security = apiSecurityResponse(error);
      if (security) return withNoStore(security);
      console.error(
        JSON.stringify({
          subsystem: "amux",
          event: "decision_maker_switch_read_failed",
          code: error instanceof AmuxDbBoundaryError ? error.code : null,
        }),
      );
      return NextResponse.json(
        { error: "switch_state_unavailable" },
        { status: 503, headers: noStoreHeaders },
      );
    }
  });
}

export async function POST(request: Request) {
  return withAmuxRouteBudget(async () => {
    try {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id || !isAdminSession(session)) return notFound();
      if (!hasAdminPermission(session, "ops:write")) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
      }
      await assertRecentAdminAuthentication(session);
      await consumeApiRateLimit(request, session.user.id, "admin-amux-decision-maker-switch-change", {
        minute: 10,
        day: 100,
      });
      const body = await readLimitedJson(request, 256, bodySchema);
      const event = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerSwitchChange, (tx) =>
        recordDecisionMakerSwitchByOperator(tx, {
          session,
          request,
          scope: body.scope,
          value: body.value,
        }),
      );
      return NextResponse.json(
        {
          scope: body.scope,
          value: body.value,
          action: event.action,
          eventId: event.eventId,
          sequence: event.sequence,
          createdAt: event.createdAt,
        },
        { headers: noStoreHeaders },
      );
    } catch (error) {
      const approvalResponse = adminApprovalErrorResponse(error);
      if (approvalResponse) return withNoStore(approvalResponse);
      if (error instanceof DecisionMakerSwitchWriteError) {
        return error.code === "no_operator"
          ? notFound()
          : NextResponse.json({ error: error.code }, { status: 400, headers: noStoreHeaders });
      }
      const security = apiSecurityResponse(error);
      if (security) return withNoStore(security);
      const code = error instanceof AmuxDbBoundaryError ? error.code : null;
      console.error(
        JSON.stringify({ subsystem: "amux", event: "decision_maker_switch_change_failed", code }),
      );
      // Rolled back unless the outcome is unknown; then only a read says which.
      return NextResponse.json(
        { error: code === "AMUX_DB_OUTCOME_UNKNOWN" ? "outcome_unknown" : "switch_change_failed" },
        { status: 503, headers: noStoreHeaders },
      );
    }
  });
}
