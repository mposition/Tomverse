import "server-only";

import { zernioCommentsQuery } from "@/lib/zernioCommentsQuery";
import { ZERNIO_API_BASE_URL } from "@/lib/zernioStatusQuery";

/**
 * Zernio's comments query for the comment monitor's route, from the same
 * credential the publisher uses. Null without a key, as the publisher's
 * adapter is.
 */
export function buildZernioCommentsQueryFromEnv(callBudgetMs: number) {
  const apiKey = process.env.ZERNIO_API_KEY?.trim() ?? "";
  if (apiKey === "") return null;
  return zernioCommentsQuery({ apiKey, baseUrl: ZERNIO_API_BASE_URL, callBudgetMs });
}
