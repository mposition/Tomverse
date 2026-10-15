export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import {
  readMarketingWebhookProductionConfigLive,
  readMarketingWebhookProductionRecord,
} from "@/lib/marketingWebhookProductionConfigStore";
import { MARKETING_WEBHOOK_RECORD_ID_PATTERN } from "@/lib/marketingWebhookVerification";
import { prisma } from "@/lib/prisma";

/**
 * GET: what a production configuration signature would bind, read now -- the
 * environment, deploy commit, pipeline fingerprint, live configuration digest,
 * the stored generation, the next one and the stored apply scope. With
 * `?recordId=`, also that verification record as the tree carries it: its
 * digest, what it observed, and the audit row that signed exactly those bytes.
 *
 * Ordinary admin authentication, as for every marketing read: the screen has
 * to show these before anyone signs, and the signing route checks them again.
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
    const recordId = new URL(req.url).searchParams.get("recordId");
    if (recordId !== null && !MARKETING_WEBHOOK_RECORD_ID_PATTERN.test(recordId)) {
      return NextResponse.json({ error: "Not a verification record id." }, { status: 400 });
    }
    const [live, record] = await Promise.all([
      readMarketingWebhookProductionConfigLive(prisma),
      recordId === null ? Promise.resolve(null) : readMarketingWebhookProductionRecord(prisma, recordId),
    ]);
    return NextResponse.json({ ...live, record });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to read the production webhook configuration:", error);
    return NextResponse.json({ error: "Failed to read the production webhook configuration." }, { status: 500 });
  }
}
