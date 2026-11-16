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
  BoardImportError,
  boardImportContentTypeAccepted,
} from "@/lib/amux/boardImportCore";
import { applyAmuxReconciliation } from "@/lib/amux/boardReconciliation";
import {
  AMUX_RECONCILIATION_RAW_BODY_MAX_BYTES,
  planAmuxReconciliation,
  previewAmuxReconciliation,
} from "@/lib/amux/boardReconciliationCore";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };
const ACTIONS = new Set(["preview", "apply"]);

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
      await consumeApiRateLimit(request, userId, `admin-amux-reconciliation-${action}`, { minute: 10, day: 100 });
    }
    const raw = await readLimitedText(request, AMUX_RECONCILIATION_RAW_BODY_MAX_BYTES);
    if (action === "preview") {
      return NextResponse.json(previewAmuxReconciliation(raw), {
        headers: noStoreHeaders,
      });
    }
    const planned = planAmuxReconciliation(raw);
    if (!planned.ok) {
      return NextResponse.json({ error: planned.code, writes: 0 }, { status: 409, headers: noStoreHeaders });
    }
    return NextResponse.json(
      await applyAmuxReconciliation({ session: auth.session, request, plan: planned }),
      { headers: noStoreHeaders },
    );
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return withNoStore(approvalResponse);
    if (error instanceof BoardImportError) {
      return NextResponse.json({ error: error.code, writes: 0 }, { status: error.httpStatus, headers: noStoreHeaders });
    }
    const security = apiSecurityResponse(error);
    if (security) return withNoStore(security);
    console.error("AMUX reconciliation preview failed");
    return NextResponse.json({ error: "reconciliation_failed" }, { status: 500, headers: noStoreHeaders });
  }
}
