export const dynamic = "force-dynamic";
// A video can be a gigabyte, and it is hashed here end to end.
export const maxDuration = 300;

import { NextResponse } from "next/server";

import { MARKETING_ASSET_ID, MARKETING_ASSET_MAX_BYTES, MarketingAssetRefusedError } from "@/lib/marketingAssetCore";
import { confirmMarketingAssetUpload, readMarketingAssetUploadTarget } from "@/lib/marketingAssetStore";
import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import { marketingGeneratorAuthorized, marketingMediaSecret } from "@/lib/marketingGeneratorAuth";
import { runMarketingTransaction } from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";
import { copyR2Object, deleteR2Object, hashR2Object, validateR2ObjectMetadata } from "@/lib/r2";

// The media CLI says the file is uploaded (operator decision 2026-10-31).
//
// The upload is checked against what was announced -- type and exact size
// (a mismatch is removed), then the SHA-256 of the bytes themselves -- and only
// the version that was hashed is copied to the key the asset is kept at, which
// no upload URL is signed for. So the bytes a person later approves are the
// announced ones, and an upload URL still valid afterwards cannot change them.

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

  if (!target.uploaded) {
    try {
      await validateR2ObjectMetadata(target.uploadKey, {
        maxBytes: MARKETING_ASSET_MAX_BYTES[target.kind],
        expectedContentType: target.contentType,
        expectedSize: target.bytes,
      });
    } catch {
      // Missing, or not the announced type and size (and now removed): upload it again.
      return json({ code: "upload_not_found_or_invalid" }, 409);
    }
    let hashed: { sha256: string; size: number; etag: string | null };
    try {
      hashed = await hashR2Object(target.uploadKey, { maxBytes: MARKETING_ASSET_MAX_BYTES[target.kind] });
    } catch {
      return json({ code: "upload_not_found_or_invalid" }, 409);
    }
    // Without a version to pin the copy to, the copy could be of other bytes.
    if (!hashed.etag) return json({ code: "upload_changed_while_verified" }, 409);
    if (hashed.sha256 !== target.sha256 || hashed.size !== target.bytes) {
      await deleteR2Object(target.uploadKey).catch(() => undefined);
      return json({ code: "upload_hash_mismatch" }, 409);
    }
    try {
      // Only the version that was hashed: one replaced since is refused.
      await copyR2Object(target.uploadKey, target.r2Key, { ifMatch: hashed.etag });
    } catch {
      return json({ code: "upload_changed_while_verified" }, 409);
    }
  }

  let result: { assetId: string; uploadedAt: string };
  try {
    result = await runMarketingTransaction(
      prisma,
      (tx) => confirmMarketingAssetUpload(tx, { assetId, bytes: target.bytes }),
      { maxWait: 5_000, timeout: 15_000 },
    );
  } catch (error) {
    if (error instanceof MarketingAssetRefusedError) return json({ code: error.code }, error.status);
    return json({ code: "outcome_unknown" }, 500);
  }
  // The upload key has done its work; a leftover is harmless and costs a little.
  await deleteR2Object(target.uploadKey).catch(() => undefined);
  return json({ result }, 200);
}
