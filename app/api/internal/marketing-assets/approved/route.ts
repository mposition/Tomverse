export const dynamic = "force-dynamic";
export const maxDuration = 15;

import { NextResponse } from "next/server";

import { readApprovedMarketingAssetsForMediaCli } from "@/lib/marketingAssetStore";
import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import { marketingGeneratorAuthorized, marketingMediaSecret } from "@/lib/marketingGeneratorAuth";
import { prisma } from "@/lib/prisma";

// The media CLI's daily job builds new assets only from assets a person
// approved (owner decision 2026-11-04), so it asks which those are. The answer
// names ids, kinds, channels, locales and validity -- no file, key, URL or
// words -- under the same secret the CLI submits with.

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
    return json({ result: { assets: await readApprovedMarketingAssetsForMediaCli(prisma) } }, 200);
  } catch {
    return json({ code: "unavailable" }, 503);
  }
}
