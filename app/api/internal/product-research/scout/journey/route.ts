export const dynamic = "force-dynamic";
export const maxDuration = 120;

import {
  isProductResearchRouteAuthorized,
  isProductResearchRouteEnabled,
  productResearchInternalError,
  productResearchJson,
  productResearchNotFound,
  productResearchUnauthorized,
} from "@/lib/productResearchObservationRouteAuth";
import { PRODUCT_RESEARCH_SCOUT_SECRET_ENV, PRODUCT_RESEARCH_SCOUT_SWITCH_ENV } from "@/lib/productResearchScoutCore";
import {
  JOURNEY_FINDINGS_SUBJECT,
  JOURNEY_JUDGE_CALLS,
  JOURNEY_SUBJECT,
  SCOUT_JOURNEY_TASK_ENV,
  runJourney,
} from "@/lib/productResearchScoutJourneyCore";
import { scoutLlmFor } from "@/lib/productResearchScoutLlm";
import { readScoutSettings, settleScoutCall, startScoutCall } from "@/lib/productResearchScoutSettings";
import { recentSuggestionTitles } from "@/lib/productResearchScoutStore";

// The Scout's journey (docs/policy/product-research-agent.md §14). The walker
// posts here with no body when it holds today's `generated.journey` permit; the
// app asks the Scout's model for one journey across Chat and answers it, and the
// walker follows it. Off unless its own switch is set as well as the Scout's:
// off means this path does not exist. The model call is taken from the Scout's
// daily cap, keeping one call free to judge what the journey shows.

export async function POST(request: Request) {
  if (!isProductResearchRouteEnabled(process.env, PRODUCT_RESEARCH_SCOUT_SWITCH_ENV)) return productResearchNotFound();
  if (!isProductResearchRouteEnabled(process.env, SCOUT_JOURNEY_TASK_ENV)) return productResearchNotFound();
  if (!isProductResearchRouteAuthorized(request, process.env, PRODUCT_RESEARCH_SCOUT_SECRET_ENV)) {
    return productResearchUnauthorized();
  }

  try {
    const answer = await runJourney({
      now: new Date(),
      recentTitles: () => recentSuggestionTitles(JOURNEY_FINDINGS_SUBJECT),
      model: async () => scoutLlmFor((await readScoutSettings()).modelId),
      reserve: (modelId) => startScoutCall({ subject: JOURNEY_SUBJECT, modelId, keepFree: JOURNEY_JUDGE_CALLS }),
      settle: settleScoutCall,
    });
    return productResearchJson(answer, "judged" in answer && answer.reason === "model_failed" ? 502 : 200);
  } catch (error) {
    return productResearchInternalError("product_research_scout_journey", error);
  }
}
