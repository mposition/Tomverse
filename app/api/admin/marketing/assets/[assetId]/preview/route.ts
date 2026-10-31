export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { MARKETING_ASSET_ID, MARKETING_ASSET_PREVIEW_URL_SECONDS } from "@/lib/marketingAssetCore";
import { readMarketingAssetPreviewKey } from "@/lib/marketingAssetStore";
import { prisma } from "@/lib/prisma";
import { createR2ReadUrl } from "@/lib/r2";

type RouteContext = { params: Promise<{ assetId: string }> };

/**
 * GET: the uploaded file, for a person deciding whether to approve it (or
 * looking back at one decided, retired included, as the audit trail does). A
 * redirect to a short-lived signed URL; reading is ordinary admin
 * authentication, like the rest of the Marketing console.
 */
export async function GET(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-marketing-asset-preview", { minute: 60, day: 600 });

    const { assetId } = await context.params;
    if (!MARKETING_ASSET_ID.test(assetId)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const key = await readMarketingAssetPreviewKey(prisma, assetId);
    if (!key) return NextResponse.json({ error: "Not found." }, { status: 404 });

    const url = await createR2ReadUrl(key, MARKETING_ASSET_PREVIEW_URL_SECONDS);
    return NextResponse.redirect(url, { status: 303, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    return NextResponse.json({ error: "Preview unavailable." }, { status: 500 });
  }
}
