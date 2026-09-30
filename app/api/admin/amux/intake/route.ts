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
import {
  LOCAL_INTAKE_APPLY_ENV,
  LOCAL_INTAKE_PACKAGE_MAX_BYTES,
  LOCAL_INTAKE_SOURCE_KEY_SECRET_ENV,
} from "@/lib/amux/localIntakeCore";
import { previewLocalIntakeCard, previewLocalIntakePackage } from "@/lib/amux/localIntakeRegistrationCore";
import {
  LocalIntakeOutcomeUnknownError,
  applyLocalIntakeRegistration,
  readLocalIntakeBoardSnapshot,
} from "@/lib/amux/localIntakeRegistration";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };
const ACTIONS = new Set(["preview", "register", "local-preview", "local-register"]);
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

const admitPreview = (userId: string) => {
  const now = Date.now();
  const pruned = pruneBoardImportPreviewHits([...previewHits], now);
  previewHits.clear();
  for (const [accountId, retained] of pruned) previewHits.set(accountId, retained);
  const decision = admitBoardImportPreview(previewHits.get(userId) ?? [], now);
  if (decision.retained.length === 0) previewHits.delete(userId);
  else previewHits.set(userId, decision.retained);
  return decision.allowed && decision.retained.length <= BOARD_IMPORT_PREVIEW_LIMIT;
};

const failIntake = (error: unknown) => {
  const approvalResponse = adminApprovalErrorResponse(error);
  if (approvalResponse) return withNoStore(approvalResponse);
  if (error instanceof BoardImportError) {
    const unknown =
      error instanceof AmuxIntakeOutcomeUnknownError || error instanceof LocalIntakeOutcomeUnknownError
        ? error
        : null;
    const body = unknown
      ? { error: unknown.code, retry: false as const, readBack: unknown.readBack }
      : { error: error.code, writes: 0 as const };
    return NextResponse.json(body, { status: error.httpStatus, headers: noStoreHeaders });
  }
  const security = apiSecurityResponse(error);
  if (security) return withNoStore(security);
  console.error("AMUX intake preview failed");
  return NextResponse.json({ error: "intake_failed" }, { status: 500, headers: noStoreHeaders });
};

export async function GET(request: Request) {
  try {
    const auth = await requireOwner();
    if ("response" in auth) return auth.response;
    const action = new URL(request.url).searchParams.get("action");
    if (action !== "local-snapshot") {
      return NextResponse.json({ error: "schema_rejected" }, { status: 400, headers: noStoreHeaders });
    }
    const userId = auth.session.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    if (!admitPreview(userId)) {
      return NextResponse.json({ error: "preview_rate_limited" }, { status: 429, headers: noStoreHeaders });
    }
    const generatedAt = new Date().toISOString();
    const snapshot = await readLocalIntakeBoardSnapshot(generatedAt);
    if (!snapshot.ok) {
      return NextResponse.json({ error: snapshot.code, writes: 0 }, { status: 409, headers: noStoreHeaders });
    }
    return NextResponse.json(
      { generatedAt: snapshot.generatedAt, digest: snapshot.digest, cards: snapshot.cards },
      {
      headers: {
        ...noStoreHeaders,
        "Content-Disposition": 'attachment; filename="amux-local-intake-snapshot.json"',
      },
    });
  } catch (error) {
    return failIntake(error);
  }
}

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
    const local = action === "local-preview" || action === "local-register";
    if (action !== "preview" && action !== "local-preview") {
      await consumeApiRateLimit(request, userId, `admin-amux-intake-${action}`, { minute: 10, day: 100 });
    }
    const raw = await readLimitedText(request, local ? LOCAL_INTAKE_PACKAGE_MAX_BYTES : AMUX_INTAKE_RAW_BODY_MAX_BYTES);
    if (local) {
      if (action === "local-preview" && !admitPreview(userId)) {
        return NextResponse.json({ error: "preview_rate_limited" }, { status: 429, headers: noStoreHeaders });
      }
      const generatedAt = new Date().toISOString();
      const snapshot = await readLocalIntakeBoardSnapshot(generatedAt);
      if (!snapshot.ok) {
        return NextResponse.json({ error: snapshot.code, writes: 0 }, { status: 409, headers: noStoreHeaders });
      }
      const context = {
        now: new Date(),
        liveSnapshotDigest: snapshot.digest,
        secret: process.env[LOCAL_INTAKE_SOURCE_KEY_SECRET_ENV] ?? null,
        existingIds: snapshot.cards.map((card) => card.id),
        envValue: process.env[LOCAL_INTAKE_APPLY_ENV],
      };
      if (action === "local-preview") {
        const preview = previewLocalIntakePackage(raw, context);
        return NextResponse.json(
          { ...preview, writes: 0, liveSnapshotDigest: snapshot.digest, snapshotGeneratedAt: snapshot.generatedAt },
          { headers: noStoreHeaders },
        );
      }
      const localId = new URL(request.url).searchParams.get("localId") ?? "";
      const confirmationDigest = new URL(request.url).searchParams.get("confirmationDigest") ?? undefined;
      const planned = previewLocalIntakeCard(raw, { ...context, localId, confirmationDigest });
      if (!planned.plan) {
        return NextResponse.json(
          { error: planned.code ?? "approval_required", writes: 0, digest: planned.digest },
          { status: 409, headers: noStoreHeaders },
        );
      }
      return NextResponse.json(
        await applyLocalIntakeRegistration({ session: auth.session, request, plan: planned.plan }),
        { headers: noStoreHeaders },
      );
    }
    const secret = process.env[AMUX_INTAKE_SOURCE_KEY_SECRET_ENV] ?? null;
    if (action === "preview") {
      if (!admitPreview(userId)) {
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
    return failIntake(error);
  }
}
