export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from
  "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from
  "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AMUX_V4_RESOLUTION_PREVIEW_ENV, amuxV4ResolutionPreviewEnabled } from
  "@/lib/amux/ideaResolutionChoiceCore";
import { AmuxIdeaResolutionPreviewError, readAmuxIdeaResolutionCatalog,
  previewAmuxIdeaResolution } from "@/lib/amux/ideaResolutionPreviewService";
import { AmuxIdeaAnalysisResultReadError } from
  "@/lib/amux/ideaAnalysisResultReadService";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const ref = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.number().int().nonnegative().refine(Number.isSafeInteger);
const nodeChoice = z.object({ proposalLocalId: ref,
  action: z.enum(["create", "select_existing", "reject"]), targetRef: ref.nullable(),
  targetRevision: revision.nullable(), targetDigest: digest.nullable(),
  reason: z.string().min(3).max(500).nullable() }).strict();
const cardChoice = z.object({ proposalLocalId: ref,
  action: z.enum(["register", "link_existing", "split", "merge", "reject"]),
  targetRef: ref.nullable(), targetRevision: revision.nullable(),
  targetDigest: digest.nullable(), relatedLocalRefs: z.array(ref).max(40),
  reason: z.string().min(3).max(500).nullable() }).strict();
const previewBody = z.object({ ideaId: ref,
  chunkIndex: revision.refine((value) => value < 2_147_483_647),
  nodeChoices: z.array(nodeChoice).max(40),
  cardChoices: z.array(cardChoice).max(40) }).strict();

async function owner(): Promise<Session | NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  }
  if (getAdminRole(session) !== "owner") {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
  }
  try { await assertRecentAdminAuthentication(session); } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    throw error;
  }
  return session;
}

function errorResponse(error: unknown): Response {
  if (error instanceof AmuxIdeaResolutionPreviewError ||
      error instanceof AmuxIdeaAnalysisResultReadError) {
    return NextResponse.json({ error: error.code },
      { status: error.code === "not_found" ? 404 : error.code === "catalog_too_large" ? 409 : 503,
        headers: noStore });
  }
  const security = apiSecurityResponse(error);
  if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
  console.error("AMUX v4 resolution preview unavailable");
  return NextResponse.json({ error: "resolution_preview_unavailable" },
    { status: 503, headers: noStore });
}

/** Candidate inventory only; no LLM call, decision write, or card registration. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!amuxV4ResolutionPreviewEnabled(process.env[AMUX_V4_RESOLUTION_PREVIEW_ENV])) {
      return NextResponse.json({ error: "resolution_preview_disabled" },
        { status: 503, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-resolution-preview", {
      minute: 10, day: 100,
    });
    const params = new URL(request.url).searchParams;
    if (params.size !== 1 || params.getAll("ideaId").length !== 1 ||
        !ref.safeParse(params.get("ideaId")).success) {
      return NextResponse.json({ error: "schema_rejected" }, { status: 400, headers: noStore });
    }
    return NextResponse.json(await readAmuxIdeaResolutionCatalog(session,
      params.get("ideaId")!), { headers: noStore });
  } catch (error) { return errorResponse(error); }
}

/** The owner sees a deterministic dry run. Stage 9 performs a fresh read and
 * consumes a separate, bound confirmation before any canonical write. */
export async function POST(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!amuxV4ResolutionPreviewEnabled(process.env[AMUX_V4_RESOLUTION_PREVIEW_ENV])) {
      return NextResponse.json({ error: "resolution_preview_disabled" },
        { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") return NextResponse.json({ error: "content_type_refused" },
          { status: 415, headers: noStore });
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-resolution-preview", {
      minute: 10, day: 100,
    });
    let raw: unknown;
    try { raw = JSON.parse(await readLimitedText(request, 32_768)); } catch {
      return NextResponse.json({ error: "schema_rejected" }, { status: 400, headers: noStore });
    }
    const parsed = previewBody.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore });
    const inspected = await previewAmuxIdeaResolution({ session, ...parsed.data });
    return NextResponse.json(inspected, { status: inspected.ok ? 200 : 409,
      headers: noStore });
  } catch (error) { return errorResponse(error); }
}
