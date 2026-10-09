export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxIdeaRetentionHoldError,
  commitAmuxIdeaRetentionHold, commitAmuxIdeaRetentionHoldRelease,
  readAmuxIdeaRetentionHoldScope } from
  "@/lib/amux/ideaRetentionHoldService";
import { prisma } from "@/lib/prisma";

const READ_ENV = "TOMVERSE_AMUX_V4_RETENTION_HOLD_READ";
const WRITE_ENV = "TOMVERSE_AMUX_V4_RETENTION_HOLD_WRITE";
const READ_CODE_LATCH = true;
const WRITE_CODE_LATCH = true;
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const uuid = z.string().uuid();
const createSchema = z.object({ id: uuid, ideaId: uuid,
  reasonCode: z.enum(["legal_request", "dispute", "incident", "other"]),
  days: z.number().int().min(1).max(90),
  expectedRemainingBodies: z.number().int().positive(),
  expectedAlreadyPurgedBodies: z.number().int().nonnegative(),
  replacesHoldId: uuid.optional(),
}).strict();
const releaseSchema = z.object({ holdId: uuid, ideaId: uuid }).strict();

async function requireOwner() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) return null;
  if (getAdminRole(session) !== "owner") return "forbidden" as const;
  await assertRecentAdminAuthentication(session);
  return session;
}

function failure(error: unknown): Response {
  if (isAdminReauthenticationError(error)) {
    return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
      { status: 428, headers: noStore });
  }
  if (error instanceof AmuxIdeaRetentionHoldError) {
    return NextResponse.json({ error: error.code, retryWrite: false },
      { status: error.code === "forbidden" ? 403 :
        error.code === "not_found" ? 404 :
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

/** Read-back also resolves a lost create/release response by exact hold ID. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await requireOwner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (!READ_CODE_LATCH || process.env[READ_ENV] !== "enabled") {
      return NextResponse.json({ error: "retention_hold_read_disabled" },
        { status: 409, headers: noStore });
    }
    const url = new URL(request.url);
    const ideaId = url.searchParams.get("ideaId");
    if (!ideaId || !uuid.safeParse(ideaId).success ||
        url.searchParams.getAll("ideaId").length !== 1 ||
        [...url.searchParams.keys()].length !== 1) {
      return NextResponse.json({ error: "Invalid request." },
        { status: 400, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v4-retention-hold-read", { minute: 6, day: 60 });
    const result = await prisma.$transaction(async (tx) => {
      const scope = await readAmuxIdeaRetentionHoldScope(tx, ideaId);
      const holds = await tx.amuxIdeaRetentionHold.findMany({
        where: { ideaId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20, select: { id: true, reasonCode: true, createdAt: true,
          expiresAt: true, releasedAt: true, noticeAt: true,
          noticeSentAt: true, approvalAuditLogId: true,
          releaseAuditLogId: true },
      });
      return { scope, holds };
    });
    return NextResponse.json(result, { headers: noStore });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireOwner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (!READ_CODE_LATCH || !WRITE_CODE_LATCH ||
        process.env[READ_ENV] !== "enabled" ||
        process.env[WRITE_ENV] !== "enabled") {
      return NextResponse.json({ error: "retention_hold_write_disabled" },
        { status: 409, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim()
      .toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "Invalid content type." },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v4-retention-hold-write", { minute: 2, day: 10 });
    const body = await readLimitedJson(request, 1024, createSchema);
    const result = await prisma.$transaction((tx) =>
      commitAmuxIdeaRetentionHold(tx, { session, request, ...body }),
    { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json(result, { status: 201, headers: noStore });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const session = await requireOwner();
    if (session === null) return NextResponse.json({ error: "Not found." },
      { status: 404, headers: noStore });
    if (session === "forbidden") return NextResponse.json({ error: "Forbidden." },
      { status: 403, headers: noStore });
    if (!READ_CODE_LATCH || !WRITE_CODE_LATCH ||
        process.env[READ_ENV] !== "enabled" ||
        process.env[WRITE_ENV] !== "enabled") {
      return NextResponse.json({ error: "retention_hold_write_disabled" },
        { status: 409, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim()
      .toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "Invalid content type." },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v4-retention-hold-write", { minute: 2, day: 10 });
    const body = await readLimitedJson(request, 512, releaseSchema);
    const result = await prisma.$transaction((tx) =>
      commitAmuxIdeaRetentionHoldRelease(tx, { session, request, ...body }),
    { maxWait: 5_000, timeout: 15_000 });
    return NextResponse.json(result, { headers: noStore });
  } catch (error) { return failure(error); }
}
