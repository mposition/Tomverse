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
  DecisionMakerDigestKeyError,
  loadDecisionMakerDigestKeyRing,
} from "@/lib/amux/decisionMakerDigestKeys";
import {
  DecisionMakerJudgmentWriteError,
  recordDecisionMakerJudgment,
} from "@/lib/amux/decisionMakerJudgmentStore";

/**
 * A person's judgment of an AMUX Decision Maker proposal
 * (docs/policy/amux-decision-maker.md §2-6, §6, §12 S2): confirm it, confirm
 * an edited answer instead, or reject it, with the declaration accuracy of §4.
 *
 * `ops:write` and a recent step-up, checked here before the body is read; a
 * stale step-up answers 428 through `adminApprovalErrorResponse`. The judgment
 * store does everything else in one transaction inside the AMUX DB boundary
 * `decisionMakerJudgment`: the person's audit, the judgment that closes the
 * request, and, for an edited answer, its body. It records a confirmation only
 * on the values Admin showed (`shown`), refuses one under the kill switch, and
 * records one judgment per request; a refusal wrote nothing and says why.
 *
 * Nothing here reaches a worker. A confirmed answer is delivered only by the
 * delivery path (§2-7), which this route does not call. When the
 * transaction's outcome is unknown the answer says so, and the caller reads
 * the request again instead of sending the judgment again (foundation
 * principle 7).
 *
 * The handler runs inside the AMUX route budget from its first line (§9).
 */

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStoreHeaders["Cache-Control"]);
  return response;
};

const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });

/**
 * Sizes only: the store parses every field itself (parseDmJudgmentInput) and
 * refuses anything outside the policy's shapes. An edited answer is at most
 * 8 KiB of UTF-8 (§10), so 8,192 characters bound it before the store measures
 * its bytes.
 */
const bodySchema = z
  .object({
    requestId: z.string().max(36),
    kind: z.string().max(16),
    shown: z
      .object({
        answerDigest: z.string().max(64).nullable(),
        rationaleDigest: z.string().max(64),
        optionId: z.string().max(32).nullable(),
        irreversible: z.boolean(),
        snapshotState: z.string().max(16),
        snapshotTargetSha: z.string().max(40).nullable(),
        snapshotManifestDigest: z.string().max(64).nullable(),
      })
      .strict()
      .optional(),
    accuracy: z
      .object({
        accuracy: z.string().max(16),
        mismatchedItems: z.array(z.string().max(16)).max(3).optional(),
      })
      .strict()
      .optional(),
    operatorAnswer: z.string().max(8192).optional(),
  })
  .strict();

const BODY_LIMIT_BYTES = 40 * 1024;

export async function POST(request: Request) {
  return withAmuxRouteBudget(async () => {
    try {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id || !isAdminSession(session)) return notFound();
      if (!hasAdminPermission(session, "ops:write")) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
      }
      await assertRecentAdminAuthentication(session);
      await consumeApiRateLimit(request, session.user.id, "admin-amux-decision-maker-judgment", {
        minute: 10,
        day: 200,
      });
      const body = await readLimitedJson(request, BODY_LIMIT_BYTES, bodySchema);
      // An edited answer is digested under its request's key (§10); the key
      // ring is read before the database, and only an edit needs it.
      const keyRing = body.kind === "edit_confirm" ? loadDecisionMakerDigestKeyRing() : undefined;
      const result = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerJudgment, (tx) =>
        recordDecisionMakerJudgment(tx, {
          session,
          request,
          requestId: body.requestId,
          kind: body.kind,
          shown: body.shown,
          accuracy: body.accuracy,
          operatorAnswer: body.operatorAnswer,
          keyRing,
        }),
      );
      if (!result.recorded) {
        return NextResponse.json(
          {
            error: "judgment_refused",
            reason: result.reason,
            ...("bodyRefusal" in result ? { bodyRefusal: result.bodyRefusal } : {}),
          },
          { status: 409, headers: noStoreHeaders },
        );
      }
      return NextResponse.json(
        {
          recorded: true,
          kind: result.judgment.kind,
          judgmentId: result.judgment.judgmentId,
          createdAt: result.judgment.createdAt,
        },
        { headers: noStoreHeaders },
      );
    } catch (error) {
      const approvalResponse = adminApprovalErrorResponse(error);
      if (approvalResponse) return withNoStore(approvalResponse);
      if (error instanceof DecisionMakerJudgmentWriteError) {
        if (error.code === "no_operator") return notFound();
        if (error.code === "invalid_input") {
          return NextResponse.json({ error: "invalid_judgment" }, { status: 400, headers: noStoreHeaders });
        }
      }
      if (error instanceof DecisionMakerDigestKeyError) {
        console.error(JSON.stringify({ subsystem: "amux", event: "decision_maker_judgment_failed", code: "digest_keys_unavailable" }));
        return NextResponse.json({ error: "dm_digest_keys_unavailable" }, { status: 503, headers: noStoreHeaders });
      }
      const security = apiSecurityResponse(error);
      if (security) return withNoStore(security);
      const code =
        error instanceof AmuxDbBoundaryError
          ? error.code
          : error instanceof DecisionMakerJudgmentWriteError
            ? error.code
            : null;
      console.error(JSON.stringify({ subsystem: "amux", event: "decision_maker_judgment_failed", code }));
      // Rolled back unless the outcome is unknown; then only a read says which.
      return NextResponse.json(
        { error: code === "AMUX_DB_OUTCOME_UNKNOWN" ? "outcome_unknown" : "judgment_failed" },
        { status: 503, headers: noStoreHeaders },
      );
    }
  });
}
