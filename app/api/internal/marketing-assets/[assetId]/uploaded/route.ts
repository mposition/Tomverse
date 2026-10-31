export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextResponse } from "next/server";

import { MARKETING_ASSET_ID, MARKETING_ASSET_MAX_BYTES, MarketingAssetRefusedError } from "@/lib/marketingAssetCore";
import { confirmMarketingAssetUpload, readMarketingAssetUploadTarget } from "@/lib/marketingAssetStore";
import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import { marketingGeneratorAuthorized, marketingMediaSecret } from "@/lib/marketingGeneratorAuth";
import { runMarketingTransaction } from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";
import { validateR2ObjectMetadata } from "@/lib/r2";

// The media CLI says the file is uploaded (operator decision 2026-10-31). The
// object is measured against what was announced -- type and exact size -- and
// an object that does not match is removed (validateR2ObjectMetadata), so the
// CLI uploads again. Only then is the upload recorded and the asset shown to a
// person for approval.

type RouteContext = { params: Promise<{ assetId: string }> };

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request, context: RouteContext) {
  const secret = marketingMediaSecret();
  if (!secret || !marketingGeneratorAuthorized(request, secret)) {
    return json({ error: "Unauthorized" }, 401);
  }
  if ((process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV] ?? "").trim().length > 0) {
    return json({ code: "kill_switch" }, 503);
  }
  const { assetId } = await context.params;
  if (!MARKETING_ASSET_ID.test(assetId)) return json({ code: "invalid_request" }, 400);

  const target = await readMarketingAssetUploadTarget(prisma, assetId);
  if (!target) return json({ code: "asset_not_submitted" }, 409);

  let measured: { size: number };
  try {
    measured = await validateR2ObjectMetadata(target.r2Key, {
      maxBytes: MARKETING_ASSET_MAX_BYTES[target.kind],
      expectedContentType: target.contentType,
      expectedSize: target.bytes,
    });
  } catch {
    // Missing, or not what was announced (and now removed): upload it again.
    return json({ code: "upload_not_found_or_invalid" }, 409);
  }

  try {
    const result = await runMarketingTransaction(
      prisma,
      (tx) => confirmMarketingAssetUpload(tx, { assetId, bytes: measured.size }),
      { maxWait: 5_000, timeout: 15_000 },
    );
    return json({ result }, 200);
  } catch (error) {
    if (error instanceof MarketingAssetRefusedError) return json({ code: error.code }, error.status);
    return json({ code: "outcome_unknown" }, 500);
  }
}
