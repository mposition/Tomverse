export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  BOARD_IMPORT_PREVIEW_LIMIT,
  BoardImportError,
  admitBoardImportPreview,
  boardImportContentTypeAccepted,
  pruneBoardImportPreviewHits,
} from "@/lib/amux/boardImportCore";
import { AMUX_INTAKE_APPLY_ENV, AMUX_INTAKE_RAW_BODY_MAX_BYTES } from "@/lib/amux/intakeCore";
import {
  AMUX_INTAKE_SOURCE_KEY_SECRET_ENV,
  planAmuxIntakeRegistration,
  previewAmuxIntake,
} from "@/lib/amux/intakeRegistrationCore";
import {
  AmuxIntakeOutcomeUnknownError,
  applyAmuxIntakeRegistration,
} from "@/lib/amux/intakeRegistration";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };
const ACTIONS = new Set(["preview", "register"]);
const previewHits = new Map<string, number[]>();

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStoreHeaders["Cache-Control"]);
  return response;
};

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
    const userId = auth.session.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    if (action !== "preview") {
      await consumeApiRateLimit(request, userId, `admin-amux-intake-${action}`, { minute: 10, day: 100 });
    }
    const raw = await readLimitedText(request, AMUX_INTAKE_RAW_BODY_MAX_BYTES);
    const secret = process.env[AMUX_INTAKE_SOURCE_KEY_SECRET_ENV] ?? null;
    if (action === "preview") {
      const now = Date.now();
      const pruned = pruneBoardImportPreviewHits([...previewHits], now);
      previewHits.clear();
      for (const [accountId, retained] of pruned) previewHits.set(accountId, retained);
      const decision = admitBoardImportPreview(previewHits.get(userId) ?? [], now);
      if (decision.retained.length === 0) previewHits.delete(userId);
      else previewHits.set(userId, decision.retained);
      if (!decision.allowed || decision.retained.length > BOARD_IMPORT_PREVIEW_LIMIT) {
        return NextResponse.json({ error: "preview_rate_limited" }, { status: 429, headers: noStoreHeaders });
      }
      return NextResponse.json(previewAmuxIntake(raw, secret, process.env[AMUX_INTAKE_APPLY_ENV]), {
        headers: noStoreHeaders,
      });
    }
    const planned = planAmuxIntakeRegistration(raw, secret);
    if (!planned.ok) {
      return NextResponse.json({ error: planned.code, writes: 0 }, { status: 409, headers: noStoreHeaders });
    }
    return NextResponse.json(
      await applyAmuxIntakeRegistration({ session: auth.session, request, plan: planned.plan }),
      { headers: noStoreHeaders },
    );
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return withNoStore(approvalResponse);
    if (error instanceof BoardImportError) {
      const body =
        error instanceof AmuxIntakeOutcomeUnknownError
          ? { error: error.code, retry: false as const, readBack: error.readBack }
          : { error: error.code, writes: 0 as const };
      return NextResponse.json(body, { status: error.httpStatus, headers: noStoreHeaders });
    }
    const security = apiSecurityResponse(error);
    if (security) return withNoStore(security);
    console.error("AMUX intake preview failed");
    return NextResponse.json({ error: "intake_failed" }, { status: 500, headers: noStoreHeaders });
  }
}
