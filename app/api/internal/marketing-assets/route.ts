export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextResponse } from "next/server";

import {
  MARKETING_ASSET_MAX_BODY_BYTES,
  MarketingAssetRefusedError,
} from "@/lib/marketingAssetCore";
import { marketingAssetSubmissionSchema } from "@/lib/marketingAssetSubmission";
import { submitMarketingAsset } from "@/lib/marketingAssetStore";
import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import {
  marketingGeneratorAuthorized,
  marketingMediaSecret,
  parseMarketingGeneratorJson,
  readMarketingGeneratorBody,
} from "@/lib/marketingGeneratorAuth";
import { runMarketingTransaction } from "@/lib/marketingStore";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";
import { createR2UploadUrl } from "@/lib/r2";

// The media CLI announces a file (operator decision 2026-10-31): the registry
// entry it will become and what the bytes are. The answer is a short-lived URL
// for the upload key only; the confirmation route verifies the bytes there and
// copies them to the key the asset is kept at, which no URL is signed for. Nothing here is trusted for a post until a person approves it in
// Admin.

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request) {
  const secret = marketingMediaSecret();
  if (!secret || !marketingGeneratorAuthorized(request, secret)) {
    return json({ error: "Unauthorized" }, 401);
  }
  // Any non-empty value is on, as at every marketing gate.
  if ((process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV] ?? "").trim().length > 0) {
    return json({ code: "kill_switch" }, 503);
  }

  const raw = await readMarketingGeneratorBody(request, MARKETING_ASSET_MAX_BODY_BYTES);
  if (raw === null) return json({ code: "body_too_large" }, 413);
  const parsed = marketingAssetSubmissionSchema.safeParse(parseMarketingGeneratorJson(raw));
  if (!parsed.success) return json({ code: "invalid_request" }, 400);

  let stored: { assetId: string; uploadKey: string; existing: boolean };
  try {
    stored = await runMarketingTransaction(prisma, (tx) => submitMarketingAsset(tx, parsed.data), {
      maxWait: 5_000,
      timeout: 15_000,
    });
  } catch (error) {
    if (error instanceof MarketingAssetRefusedError) return json({ code: error.code }, error.status);
    void reportOperationalIncident({
      code: "MARKETING_ASSET_SUBMIT_FAILED",
      title: "Marketing asset submission could not be recorded",
      error,
      severity: "error",
      cooldownMs: 30 * 60 * 1_000,
      context: { component: "marketing-assets" },
    }).catch((reportError: unknown) => {
      console.error("Marketing asset incident could not be reported:", reportError);
    });
    // Committed with the answer lost, or rolled back: the same submission
    // resent is read back.
    return json({ code: "outcome_unknown" }, 500);
  }

  const uploadUrl = await createR2UploadUrl(stored.uploadKey, parsed.data.contentType, parsed.data.bytes);
  return json(
    {
      result: {
        assetId: stored.assetId,
        existing: stored.existing,
        upload: { method: "PUT", url: uploadUrl, contentType: parsed.data.contentType },
      },
    },
    200,
  );
}
