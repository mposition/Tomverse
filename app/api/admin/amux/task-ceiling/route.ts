export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { AmuxLegacyCardOwnerError, assertAmuxLegacyCardOwner } from "@/lib/amux/legacyCardOwnerService";
import { reapproveAmuxV4TaskCeilingForOwner } from "@/lib/amux/v4TaskCeilingReapprovalService";
import { authOptions } from "@/lib/auth";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

// The owner re-approves a registered Task's cost ceiling at the current
// catalog price (lib/amux/v4TaskCeilingReapprovalCore.ts):
//
//   { taskId, revision, catalogDigest, ceilingMicroUsd, ownerConfirmed: true }
//
// `catalogDigest` and `ceilingMicroUsd` are what the owner was shown; a price
// that moved since is refused (`cost_changed`), never approved unseen.

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

const body = z.object({
  taskId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  revision: z.number().int().nonnegative(),
  catalogDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  ceilingMicroUsd: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  ownerConfirmed: z.literal(true),
}).strict();

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) return json({ error: "not_found" }, 404);
    if (getAdminRole(session) !== "owner" || !hasValidMutationOrigin(request)) {
      return json({ error: "forbidden" }, 403);
    }
    await assertAmuxLegacyCardOwner(session);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return json({ error: "content_type_refused" }, 415);
    }
    await consumeApiRateLimit(request, session.user.id, "admin-amux-task-ceiling-write",
      { minute: 10, day: 100 });
    const parsed = await readLimitedJson(request, 1_024, body);
    const result = await reapproveAmuxV4TaskCeilingForOwner({ session, request, ...parsed });
    if (result.outcome === "not_found") return json({ error: "not_found" }, 404);
    if (result.outcome === "refused") return json({ error: "not_reapprovable", reason: result.reason }, 409);
    return json({ status: "reapproved", ceilingMicroUsd: result.ceilingMicroUsd });
  } catch (error) {
    if (isAdminReauthenticationError(error)) return json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, 428);
    if (error instanceof AmuxLegacyCardOwnerError) {
      return json({ error: error.code }, error.code === "forbidden" ? 403 : 409);
    }
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    console.error(JSON.stringify({ event: "amux_task_ceiling_reapproval_failed" }));
    return json({ error: "outcome_unknown" }, 503);
  }
}
