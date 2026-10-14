export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxCardDisplayKeyBackfillError, applyAmuxCardDisplayKeyBackfill,
  previewAmuxCardDisplayKeyBackfill } from "@/lib/amux/cardDisplayKeyBackfillService";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

/**
 * The card number backfill (docs/policy/amux-card-display-key.md §5). GET is
 * the dry run; POST applies exactly the plan whose digest the owner saw.
 * Owner only, with a recent step-up for both: the plan shows Feature titles.
 */

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const bodySchema = z.object({ planDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStore["Cache-Control"]);
  return response;
};

async function requireRecentOwner() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return { response: Response.json({ error: "Not found." },
      { status: 404, headers: noStore }) } as const;
  }
  if (getAdminRole(session) !== "owner") {
    return { response: Response.json({ error: "Forbidden." },
      { status: 403, headers: noStore }) } as const;
  }
  try { await assertRecentAdminAuthentication(session); }
  catch (error) {
    if (isAdminReauthenticationError(error)) return {
      response: Response.json({ error:
        "Recent administrator authentication is required.",
        code: "ADMIN_REAUTHENTICATION_REQUIRED" },
      { status: 428, headers: noStore }),
    } as const;
    throw error;
  }
  return { session } as const;
}

export async function GET(request: Request) {
  try {
    const auth = await requireRecentOwner();
    if ("response" in auth) return auth.response;
    await consumeApiRateLimit(request, auth.session.user.id,
      "admin-amux-card-display-key-backfill-read", { minute: 10, day: 100 });
    const { plan, digest } = await previewAmuxCardDisplayKeyBackfill();
    return Response.json({ planDigest: digest, ...plan }, { headers: noStore });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return withNoStore(security);
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireRecentOwner();
    if ("response" in auth) return auth.response;
    if (!hasValidMutationOrigin(request)) {
      return Response.json({ error: "origin_refused" },
        { status: 403, headers: noStore });
    }
    await consumeApiRateLimit(request, auth.session.user.id,
      "admin-amux-card-display-key-backfill", { minute: 3, day: 20 });
    const body = await readLimitedJson(request, 512, bodySchema);
    return Response.json(await applyAmuxCardDisplayKeyBackfill({
      session: auth.session, request, expectedDigest: body.planDigest,
    }), { headers: noStore });
  } catch (error) {
    if (error instanceof AmuxCardDisplayKeyBackfillError) {
      return Response.json({ error: error.code },
        { status: error.httpStatus, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) return withNoStore(security);
    throw error;
  }
}
