export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { readMarketingWebhookProductionConfigLive } from "@/lib/marketingWebhookProductionConfigStore";
import { prisma } from "@/lib/prisma";

/**
 * GET: what a production configuration signature would bind, read now -- the
 * environment, deploy commit, pipeline fingerprint, live configuration digest,
 * the stored generation and the next one. Ordinary admin authentication, as
 * for every marketing read: the screen has to show these before anyone signs.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-marketing-webhook-production-config-read", {
      minute: 30,
      day: 300,
    });
    return NextResponse.json(await readMarketingWebhookProductionConfigLive(prisma));
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to read the production webhook configuration:", error);
    return NextResponse.json({ error: "Failed to read the production webhook configuration." }, { status: 500 });
  }
}
