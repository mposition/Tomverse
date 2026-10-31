import "server-only";

import { ZERNIO_API_BASE_URL, zernioStatusQuery } from "@/lib/zernioStatusQuery";

/**
 * Zernio's status query for the webhook receiver, from the same credential the
 * publisher uses. The receiver asks about a post it already knows and nothing
 * else, so it loads `lib/zernioStatusQuery.ts` alone: its pipeline fingerprint
 * (docs/policy/marketing-automation.md §8.1.1) no longer moves when what a
 * post sends changes. Null without a key, as the publisher's adapter is.
 */
export function buildZernioStatusQueryFromEnv(callBudgetMs: number) {
  const apiKey = process.env.ZERNIO_API_KEY?.trim() ?? "";
  if (apiKey === "") return null;
  return zernioStatusQuery({ apiKey, baseUrl: ZERNIO_API_BASE_URL, callBudgetMs });
}
