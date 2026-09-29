export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AUTO_PROMOTION_CODE_LATCH } from "@/lib/amux/autoPromotionCore";
import {
  autoHumanActor,
  consumeAutoPromotion,
  expireDueAutoGrants,
  grantAutoPromotion,
  previewAutoPromotion,
  resumeAutoPromotion,
} from "@/lib/amux/autoPromotionService";
import { BoardImportError, boardImportContentTypeAccepted } from "@/lib/amux/boardImportCore";
import { BOARD_PROMOTION_RAW_BODY_MAX_BYTES } from "@/lib/amux/boardPromotionCore";

/**
 * Owner-only auto-promotion actions.
 *
 * docs/policy/development-agent-orchestration.md, versions 8, 9 and 15.
 * Grant and consume need the code latch and the environment switch; the
 * service refuses them before a transaction otherwise. Expire-due and resume
 * only narrow or clear a stop, so they run with the switch off. Every action
 * needs the owner role and a recent step-up.
 */

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };
const ACTIONS = new Set(["preview", "grant", "consume", "expire-due", "resume"]);
const RESUME_BODY_MAX_BYTES = 4 * 1024;

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
    if (action === "preview") {
      return NextResponse.json(await previewAutoPromotion(), { headers: noStoreHeaders });
    }
    if (action === "expire-due" || action === "resume") {
      await consumeApiRateLimit(request, auth.session.user.id, `admin-amux-board-auto-promotion-${action}`, {
        minute: 10,
        day: 100,
      });
      if (action === "expire-due") {
        return NextResponse.json(await expireDueAutoGrants(autoHumanActor(auth.session, request)), {
          headers: noStoreHeaders,
        });
      }
      const raw = await readLimitedText(request, RESUME_BODY_MAX_BYTES);
      return NextResponse.json(await resumeAutoPromotion({ session: auth.session, request, raw }), {
        headers: noStoreHeaders,
      });
    }
    if (!AUTO_PROMOTION_CODE_LATCH) {
      return NextResponse.json({ error: "apply_disabled" }, { status: 409, headers: noStoreHeaders });
    }
    await consumeApiRateLimit(request, auth.session.user.id, `admin-amux-board-auto-promotion-${action}`, {
      minute: 10,
      day: 100,
    });
    const raw = await readLimitedText(request, BOARD_PROMOTION_RAW_BODY_MAX_BYTES);
    if (action === "grant") {
      return NextResponse.json(await grantAutoPromotion({ session: auth.session, request, raw }), {
        status: 201,
        headers: noStoreHeaders,
      });
    }
    // A lost outcome is read back and recorded by the service, with the halt
    // rule evaluated, before this error reaches here. It is never retried.
    return NextResponse.json(await consumeAutoPromotion({ session: auth.session, request, raw }), {
      headers: noStoreHeaders,
    });
  } catch (error) {
    if (error instanceof BoardImportError) {
      return NextResponse.json(
        { error: error.code, ...(error.code === "outcome_unknown" ? { retry: false } : {}) },
        { status: error.httpStatus, headers: noStoreHeaders },
      );
    }
    const security = apiSecurityResponse(error);
    if (security) return security;
    throw error;
  }
}
