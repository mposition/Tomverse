export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxV4TaskCatalogApprovalError,
  approveAmuxV4TaskCatalog, previewAmuxV4TaskCatalog } from
  "@/lib/amux/v4TaskCostCatalogApprovalService";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const previewBody = z.object({ action: z.literal("preview"), catalog: z.unknown() }).strict();
const approveBody = z.object({ action: z.literal("approve"), catalog: z.unknown(),
  approvalId: z.uuid().regex(/^[a-f0-9-]+$/),
  catalogDigest: digest, evidenceDigest: digest,
  expectedPreviousVersion: z.number().int().min(0).max(2_147_483_646),
  ownerConfirmedEvidence: z.literal(true) }).strict();

/** Owner preview is read-only. A separate dark write path records the exact
 * reviewed version; no API request can seed a default price or start work. */
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found" },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "forbidden" },
        { status: 403, headers: noStore });
    }
    if (!hasValidMutationOrigin(request)) {
      return NextResponse.json({ error: "origin_refused" },
        { status: 403, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") {
      return NextResponse.json({ error: "content_type_refused" },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v4-task-cost-catalog", { minute: 2, day: 20 });
    let raw: unknown;
    try { raw = JSON.parse(await readLimitedText(request, 280_000)); }
    catch { return NextResponse.json({ error: "schema_rejected" },
      { status: 400, headers: noStore }); }
    const preview = previewBody.safeParse(raw);
    if (preview.success) {
      return NextResponse.json(await previewAmuxV4TaskCatalog(preview.data.catalog),
        { headers: noStore });
    }
    const approval = approveBody.safeParse(raw);
    if (!approval.success) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    const result = await approveAmuxV4TaskCatalog({ session, request,
      ...approval.data });
    return NextResponse.json(result, { status: 201, headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    if (error instanceof AmuxV4TaskCatalogApprovalError) {
      return NextResponse.json({ error: error.code, retryWrite: false },
        { status: error.code === "forbidden" ? 403 :
          error.code === "schema_rejected" ? 400 :
          error.code === "catalog_changed" ||
          error.code === "evidence_unverified" ? 409 : 503,
          headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "catalog_unavailable", retryWrite: false },
      { status: 503, headers: noStore });
  }
}
