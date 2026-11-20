export const dynamic = "force-dynamic";
export const maxDuration = 15;

import { NextResponse } from "next/server";

import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import { readMarketingFeaturesDocument } from "@/lib/marketingFeatureFacts";
import { marketingGeneratorAuthorized, marketingMediaSecret } from "@/lib/marketingGeneratorAuth";
import { prisma } from "@/lib/prisma";

// The box's Higgsfield image job reads the ad facts an operator keeps in
// Admin › Marketing › Settings › Ad facts, in the shape of
// tools/marketing-video/features.json, under the secret it already submits
// with. Read-only; the job falls back to that file when this cannot answer.

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request) {
  const secret = marketingMediaSecret();
  if (!secret || !marketingGeneratorAuthorized(request, secret)) {
    return json({ error: "Unauthorized" }, 401);
  }
  // Any non-empty value is on, as at every marketing gate.
  if ((process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV] ?? "").trim().length > 0) {
    return json({ code: "kill_switch" }, 503);
  }
  try {
    const document = await readMarketingFeaturesDocument(prisma);
    if (document.features.length === 0) return json({ code: "empty" }, 503);
    return json({ result: document }, 200);
  } catch {
    return json({ code: "unavailable" }, 503);
  }
}
