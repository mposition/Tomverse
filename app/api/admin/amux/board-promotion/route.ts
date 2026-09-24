export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson, readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  BOARD_IMPORT_PREVIEW_LIMIT,
  BoardImportError,
  admitBoardImportPreview,
  boardImportContentTypeAccepted,
  pruneBoardImportPreviewHits,
} from "@/lib/amux/boardImportCore";
import { BOARD_PROMOTION_RAW_BODY_MAX_BYTES } from "@/lib/amux/boardPromotionCore";
import {
  applyBoardPromotion,
  approveBoardPromotion,
  expireBoardPromotion,
  expireDueBoardPromotions,
  markBoardPromotionOutcomeUnknown,
  prepareBoardPromotion,
  previewBoardPromotion,
  rejectBoardPromotion,
} from "@/lib/amux/boardPromotionService";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStoreHeaders["Cache-Control"]);
  return response;
};

const approvalSchema = z
  .object({
    approvalId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  })
  .strict();

const ACTIONS = new Set(["preview", "prepare", "approve", "reject", "expire", "expire-due", "apply"]);
const previewHits = new Map<string, number[]>();

const requireOwner = async () => {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return { response: NextResponse.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders }) } as const;
  }
  if (getAdminRole(session) !== "owner") {
    return { response: NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders }) } as const;
  }
  try {
    await assertRecentAdminAuthentication(session);
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return {
        response: NextResponse.json(
          { error: "Recent administrator authentication is required.", code: "ADMIN_REAUTHENTICATION_REQUIRED" },
          { status: 428, headers: noStoreHeaders },
        ),
      } as const;
    }
    throw error;
  }
  return { session } as const;
};

export async function POST(request: Request) {
  let approvalId: string | null = null;
  try {
    const auth = await requireOwner();
    if ("response" in auth) return auth.response;
    const action = new URL(request.url).searchParams.get("action");
    if (!action || !ACTIONS.has(action)) {
      return NextResponse.json({ error: "schema_rejected" }, { status: 400, headers: noStoreHeaders });
    }
    if (!boardImportContentTypeAccepted(request.headers.get("content-type"))) {
      return NextResponse.json({ error: "content_type_refused" }, { status: 415, headers: noStoreHeaders });
    }
    if (action !== "preview") {
      await consumeApiRateLimit(request, auth.session.user.id, `admin-amux-board-promotion-${action}`, {
        minute: 10,
        day: 100,
      });
    }
    if (action === "preview") {
      const now = Date.now();
      const pruned = pruneBoardImportPreviewHits([...previewHits], now);
      previewHits.clear();
      for (const [userId, retained] of pruned) previewHits.set(userId, retained);
      const decision = admitBoardImportPreview(previewHits.get(auth.session.user.id) ?? [], now);
      if (decision.retained.length === 0) previewHits.delete(auth.session.user.id);
      else previewHits.set(auth.session.user.id, decision.retained);
      if (!decision.allowed || decision.retained.length > BOARD_IMPORT_PREVIEW_LIMIT) {
        return NextResponse.json({ error: "preview_rate_limited" }, { status: 429, headers: noStoreHeaders });
      }
      const raw = await readLimitedText(request, BOARD_PROMOTION_RAW_BODY_MAX_BYTES);
      return NextResponse.json(await previewBoardPromotion(raw), { headers: noStoreHeaders });
    }
    if (action === "prepare") {
      const raw = await readLimitedText(request, BOARD_PROMOTION_RAW_BODY_MAX_BYTES);
      const prepared = await prepareBoardPromotion({ session: auth.session, request, raw });
      return NextResponse.json(prepared, { status: prepared.status === "prepared" ? 201 : 409, headers: noStoreHeaders });
    }
    if (action === "expire-due") {
      return NextResponse.json(await expireDueBoardPromotions({ session: auth.session, request }), {
        headers: noStoreHeaders,
      });
    }
    const body = await readLimitedJson(request, 4 * 1024, approvalSchema);
    approvalId = body.approvalId;
    if (action === "approve") {
      return NextResponse.json(await approveBoardPromotion({ session: auth.session, request, approvalId }), {
        headers: noStoreHeaders,
      });
    }
    if (action === "reject") {
      return NextResponse.json(await rejectBoardPromotion({ session: auth.session, request, approvalId }), {
        headers: noStoreHeaders,
      });
    }
    if (action === "expire") {
      return NextResponse.json(await expireBoardPromotion({ session: auth.session, request, approvalId }), {
        headers: noStoreHeaders,
      });
    }
    return NextResponse.json(await applyBoardPromotion({ session: auth.session, request, approvalId }), {
      headers: noStoreHeaders,
    });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return withNoStore(approvalResponse);
    if (error instanceof BoardImportError && error.code === "outcome_unknown") {
      const markerId = error.approvalId ?? approvalId;
      if (markerId) {
        try {
          const session = await getServerSession(authOptions);
          if (session?.user?.id) await markBoardPromotionOutcomeUnknown({ session, request, approvalId: markerId });
        } catch {
          // The marker is itself uncertain. Do not try the promotion again.
        }
      }
      return NextResponse.json({ error: "outcome_unknown", retry: false }, { status: 409, headers: noStoreHeaders });
    }
    if (error instanceof BoardImportError) {
      return NextResponse.json(
        { error: error.code, ...(error.code === "outcome_unknown" ? { retry: false } : {}) },
        { status: error.httpStatus, headers: noStoreHeaders },
      );
    }
    const security = apiSecurityResponse(error);
    if (security) return withNoStore(security);
    console.error("AMUX board promotion failed");
    return NextResponse.json({ error: "board_promotion_failed" }, { status: 500, headers: noStoreHeaders });
  }
}
