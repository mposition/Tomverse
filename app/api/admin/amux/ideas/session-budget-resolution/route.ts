export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxSessionBudgetResolutionError,
  commitAmuxSessionBudgetUnknownResolution,
  readAmuxSessionBudgetResolution } from
  "@/lib/amux/ideaSessionAnalysisBudgetResolutionService";
import { prisma } from "@/lib/prisma";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const READ_ENV = "TOMVERSE_AMUX_V19_SESSION_BUDGET_RESOLUTION_READ";
const WRITE_ENV = "TOMVERSE_AMUX_V19_SESSION_BUDGET_RESOLUTION_WRITE";
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const uuid = z.string().uuid();
const bodySchema = z.object({ claimId: uuid,
  verification: z.enum(["proven_not_started", "not_proven"]),
  localEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  ownerConfirmed: z.literal(true) }).strict();

async function owner() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) return null;
  return getAdminRole(session) === "owner" ? session : "forbidden" as const;
}

function failure(error: unknown): Response {
  if (isAdminReauthenticationError(error)) {
    return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
      { status: 428, headers: noStore });
  }
  if (error instanceof AmuxSessionBudgetResolutionError) {
    return NextResponse.json({ error: error.code, retryWrite: false },
      { status: error.code === "forbidden" ? 403 :
        error.code === "integrity_unavailable" ? 503 : 409,
      headers: noStore });
  }
  const security = apiSecurityResponse(error);
  if (security) {
    security.headers.set("Cache-Control", noStore["Cache-Control"]);
    return security;
  }
  return NextResponse.json({ error: "outcome_unknown", retryWrite: false },
    { status: 503, headers: noStore });
}

/** Owner-only content-free exact-claim readback. It remains available after
 * writes are switched off so an unknown POST can be reconciled. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (process.env[READ_ENV] !== "enabled") {
      return NextResponse.json({ error: "session_budget_resolution_read_disabled" },
        { status: 409, headers: noStore });
    }
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].length !== 1 || params.getAll("claimId").length !== 1) {
      return NextResponse.json({ error: "Invalid request." },
        { status: 400, headers: noStore });
    }
    const claimId = uuid.safeParse(params.get("claimId"));
    if (!claimId.success) return NextResponse.json({ error: "Invalid request." },
      { status: 400, headers: noStore });
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v19-session-budget-resolution-read", { minute: 15, day: 100 });
    const readback = await prisma.$transaction((tx) =>
      readAmuxSessionBudgetResolution(tx, { claimId: claimId.data, session }),
    { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ state: "readback", readback,
      retryAutomatically: false }, { headers: noStore });
  } catch (error) { return failure(error); }
}

/** Positive no-start evidence releases zero; all other unknown outcomes
 * consume the pre-reserved ceiling. The owner must first inspect GET. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (process.env[READ_ENV] !== "enabled" ||
        process.env[WRITE_ENV] !== "enabled") {
      return NextResponse.json({ error: "session_budget_resolution_disabled" },
        { status: 409, headers: noStore });
    }
    if (!hasValidMutationOrigin(request)) return NextResponse.json(
      { error: "Forbidden." }, { status: 403, headers: noStore });
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") return NextResponse.json(
      { error: "Invalid content type." }, { status: 415, headers: noStore });
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v19-session-budget-resolution-write", { minute: 3, day: 20 });
    const body = await readLimitedJson(request, 2_048, bodySchema);
    const resolved = await prisma.$transaction((tx) =>
      commitAmuxSessionBudgetUnknownResolution(tx,
        { ...body, session, request }),
    { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json({ state: "resolved", ...resolved,
      retryAutomatically: false }, { status: 201, headers: noStore });
  } catch (error) { return failure(error); }
}
