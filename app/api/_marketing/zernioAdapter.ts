import "server-only";

import type { MarketingPublishAdapter } from "@/lib/marketingPublishAdapter";
import { ZERNIO_API_BASE_URL, zernioPublishAdapter } from "@/lib/zernioPublishAdapter";

/**
 * The Zernio adapter, built from the one credential the app holds for it.
 *
 * Here, at the app boundary, and not in `lib/`: the plan puts `ZERNIO_API_KEY`
 * on the app service and nowhere else, and `lib/` receives a built adapter
 * rather than reading a platform credential itself. Two routes need one -- the
 * publisher and the staging webhook receiver -- and each states its own call
 * budget.
 *
 * `resolveAsset` answers null for every asset: the marketing asset store and
 * its URLs are not wired here yet, and an asset that cannot be resolved makes
 * the adapter refuse a post before anything is sent. A post with an image or a
 * video is therefore a confirmed failure until that exists -- never a post
 * published without the media a person approved.
 */
export function buildZernioAdapterFromEnv(callBudgetMs: number): MarketingPublishAdapter | null {
  const apiKey = process.env.ZERNIO_API_KEY?.trim() ?? "";
  if (apiKey === "") return null;
  return zernioPublishAdapter({
    apiKey,
    baseUrl: ZERNIO_API_BASE_URL,
    resolveAsset: async () => null,
    callBudgetMs,
  });
}
