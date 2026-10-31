import "server-only";

import { AI_ORIGIN_PROVENANCES } from "@/lib/marketingAssets";
import { readApprovedMarketingAssetLocation } from "@/lib/marketingAssetStore";
import type { MarketingPublishAdapter } from "@/lib/marketingPublishAdapter";
import { prisma } from "@/lib/prisma";
import { createR2ReadUrl } from "@/lib/r2";
import { ZERNIO_API_BASE_URL, zernioPublishAdapter, type ZernioResolvedAsset } from "@/lib/zernioPublishAdapter";

/**
 * How long the platform has to fetch a file. Zernio fetches during a publish
 * it makes now, and a long video can take a while to transfer; three hours is
 * well past that and still a short-lived link.
 */
const ASSET_URL_SECONDS = 3 * 60 * 60;

/**
 * An approved stored asset as a post needs it: a signed read URL to its file,
 * its kind, and whether it is of AI origin. Read when the post is sent, so an
 * asset retired since the approval is not published. A hand-kept registry
 * asset has no stored file and stays unresolved.
 */
async function resolveStoredAsset(assetId: string): Promise<ZernioResolvedAsset | null> {
  const location = await readApprovedMarketingAssetLocation(prisma, assetId);
  if (!location) return null;
  return {
    url: await createR2ReadUrl(location.r2Key, ASSET_URL_SECONDS),
    kind: location.kind,
    aiOrigin: (AI_ORIGIN_PROVENANCES as readonly string[]).includes(location.provenance),
  };
}

/**
 * The Zernio adapter, built from the one credential the app holds for it.
 *
 * Here, at the app boundary, and not in `lib/`: the plan puts `ZERNIO_API_KEY`
 * on the app service and nowhere else, and `lib/` receives a built adapter
 * rather than reading a platform credential itself. Two routes need one -- the
 * publisher and the staging webhook receiver -- and each states its own call
 * budget.
 *
 * `resolveAsset` reads the approved stored asset and signs a read URL for it.
 * An asset that cannot be resolved -- retired, never approved, or hand-kept with
 * no stored file -- makes the adapter refuse the post before anything is sent:
 * never a post published without the media a person approved.
 */
export function buildZernioAdapterFromEnv(callBudgetMs: number): MarketingPublishAdapter | null {
  const apiKey = process.env.ZERNIO_API_KEY?.trim() ?? "";
  if (apiKey === "") return null;
  return zernioPublishAdapter({
    apiKey,
    baseUrl: ZERNIO_API_BASE_URL,
    resolveAsset: resolveStoredAsset,
    callBudgetMs,
  });
}
