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
import { BACKLOG_METADATA_RAW_BODY_MAX_BYTES, BacklogMetadataConflict } from "@/lib/amux/backlogMetadataCore";
import {
  applyBacklogMetadata,
  backlogMetadataApplyOpen,
  previewBacklogMetadata,
} from "@/lib/amux/backlogMetadataService";

/**
 * Owner-only backlog card metadata writer.
 *
 * docs/policy/development-agent-orchestration.md (orchestration policy
 * version 15). Preview writes nothing. Apply is refused with `apply_disabled`
 * before any transaction unless the server reports that apply is open. This
 * route does not hold or pass the code latch.
 */

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStoreHeaders["Cache-Control"]);
  return response;
};

const ACTIONS = new Set(["preview", "apply"]);
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
      const raw = await readLimitedText(request, BACKLOG_METADATA_RAW_BODY_MAX_BYTES);
      return NextResponse.json(await previewBacklogMetadata(raw), { headers: noStoreHeaders });
    }
    await consumeApiRateLimit(request, auth.session.user.id, "admin-amux-backlog-metadata-apply", {
      minute: 10,
      day: 100,
    });
    if (!backlogMetadataApplyOpen()) {
      return NextResponse.json({ error: "apply_disabled" }, { status: 409, headers: noStoreHeaders });
    }
    const raw = await readLimitedText(request, BACKLOG_METADATA_RAW_BODY_MAX_BYTES);
    return NextResponse.json(await applyBacklogMetadata({ session: auth.session, request, raw }), {
      headers: noStoreHeaders,
    });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return withNoStore(approvalResponse);
    if (error instanceof BacklogMetadataConflict) {
      return NextResponse.json(
        { error: "conflict", refusal: error.refusal },
        { status: 409, headers: noStoreHeaders },
      );
    }
    if (error instanceof BoardImportError) {
      return NextResponse.json(
        { error: error.code, ...(error.code === "outcome_unknown" ? { retry: false } : {}) },
        { status: error.httpStatus, headers: noStoreHeaders },
      );
    }
    const security = apiSecurityResponse(error);
    if (security) return withNoStore(security);
    console.error("AMUX backlog metadata failed");
    return NextResponse.json({ error: "backlog_metadata_failed" }, { status: 500, headers: noStoreHeaders });
  }
}
