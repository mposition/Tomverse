export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  AMUX_V4_FRONTIER_CATALOG_BODY_MAX_BYTES,
  AMUX_V4_FRONTIER_CATALOG_READ_ENV,
  AMUX_V4_FRONTIER_CATALOG_WRITE_ENV,
  frontierCatalogReadPermitted,
  frontierCatalogWritePermitted,
  inspectFrontierCatalogWrite,
  isFrontierApprovalId,
} from "@/lib/amux/ideaFrontierCatalogWriteCore";
import {
  FrontierCatalogWriteError,
  writeFrontierCatalogDecision,
} from "@/lib/amux/ideaFrontierCatalogWrite";
import {
  listApprovedAmuxIdeaFrontierModels,
  readCurrentAmuxIdeaFrontierSelection,
} from "@/lib/amux/ideaFrontierCatalogRead";
import { prisma } from "@/lib/prisma";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

const owner = async (): Promise<Session | NextResponse> => {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  }
  if (getAdminRole(session) !== "owner") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStore });
  }
  try {
    await assertRecentAdminAuthentication(session);
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    throw error;
  }
  return session;
};

const failure = (error: unknown): Response => {
  if (isAdminReauthenticationError(error)) {
    return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
      { status: 428, headers: noStore });
  }
  if (error instanceof FrontierCatalogWriteError) {
    return NextResponse.json({ error: error.code, retryWrite: false,
      ...(error.approvalId ? { approvalId: error.approvalId } : {}) },
    { status: error.httpStatus, headers: noStore });
  }
  const security = apiSecurityResponse(error);
  if (security) {
    security.headers.set("Cache-Control", noStore["Cache-Control"]);
    return security;
  }
  console.error("AMUX v4 Frontier catalog route failed");
  return NextResponse.json({ error: "catalog_unavailable", retryWrite: false },
    { status: 503, headers: noStore });
};

/** Dark owner-only write route; no environment setting can activate it. */
export async function POST(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!frontierCatalogWritePermitted(process.env[AMUX_V4_FRONTIER_CATALOG_WRITE_ENV])) {
      return NextResponse.json({ error: "write_disabled" }, { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "content_type_refused" },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-frontier-catalog-write", {
      minute: 5, day: 30,
    });
    const inspected = inspectFrontierCatalogWrite(
      await readLimitedText(request, AMUX_V4_FRONTIER_CATALOG_BODY_MAX_BYTES));
    if (!inspected.ok) {
      return NextResponse.json({ error: inspected.code },
        { status: inspected.code === "too_large" ? 413 : 400, headers: noStore });
    }
    const result = await writeFrontierCatalogDecision({
      session, request, decision: inspected.request,
    });
    return NextResponse.json(result, {
      status: inspected.request.action === "approve" ? 201 : 200,
      headers: noStore,
    });
  } catch (error) {
    return failure(error);
  }
}

/** Read-back remains separate from the write switch for unknown outcomes. */
export async function GET(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!frontierCatalogReadPermitted(process.env[AMUX_V4_FRONTIER_CATALOG_READ_ENV])) {
      return NextResponse.json({ error: "read_disabled" }, { status: 503, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-frontier-catalog-read", {
      minute: 15, day: 100,
    });
    const params = new URL(request.url).searchParams;
    if (params.get("mode") === "available" && [...params.keys()].length === 1) {
      const catalog = await listApprovedAmuxIdeaFrontierModels();
      return catalog.decision === "catalog_current"
        ? NextResponse.json({ state: "available", models: catalog.models,
          transferAuthorized: false }, { headers: noStore })
        : NextResponse.json({ error: catalog.reason, state: "hold",
          transferAuthorized: false }, { status: 503, headers: noStore });
    }
    if (params.get("mode") === "check" && [...params.keys()].length === 4 &&
        ["mode", "provider", "modelId", "reasoningEffort"].every((key) => params.has(key)) &&
        [...params.keys()].every((key) =>
          ["mode", "provider", "modelId", "reasoningEffort"].includes(key))) {
      const decision = await readCurrentAmuxIdeaFrontierSelection({
        provider: params.get("provider") ?? "",
        modelId: params.get("modelId") ?? "",
        reasoningEffort: params.get("reasoningEffort") ?? "",
      });
      if (decision.decision === "selection_current") {
        return NextResponse.json({ state: "current", approvalId: decision.approvalId,
          approvalVersion: decision.approvalVersion, transferAuthorized: false },
        { headers: noStore });
      }
      return NextResponse.json({ state: decision.decision, error: decision.reason,
        transferAuthorized: false },
      { status: decision.decision === "hold" ? 503 : 409, headers: noStore });
    }
    if ([...params.keys()].length !== 1 || !params.has("approvalId")) {
      return NextResponse.json({ error: "schema_rejected" }, { status: 400, headers: noStore });
    }
    const approvalId = params.get("approvalId");
    if (!approvalId || !isFrontierApprovalId(approvalId)) {
      return NextResponse.json({ error: "schema_rejected" }, { status: 400, headers: noStore });
    }
    const row = await prisma.amuxIdeaFrontierModelApproval.findUnique({
      where: { id: approvalId },
      select: {
        id: true, provider: true, modelId: true, allowedEfforts: true,
        version: true, status: true, approvedAt: true,
        approvedByUserId: true, approvalAuditLogId: true,
        revokedAt: true, revokedByUserId: true, revocationAuditLogId: true,
      },
    });
    // An absent observation is not permission to repeat a lost write.
    return NextResponse.json(row ? { state: "found", approval: row, retryWrite: false } :
      { state: "not_visible", retryWrite: false }, { headers: noStore });
  } catch (error) {
    return failure(error);
  }
}
