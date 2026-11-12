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
import { scoutLlmFor } from "@/lib/productResearchScoutLlm";
import {
  SCENARIO_FINDINGS_SUBJECT,
  SCENARIO_JUDGE_CALLS,
  SCENARIO_SUBJECT,
  SCOUT_EXPLORE_TASK_ENV,
  runScenario,
} from "@/lib/productResearchScoutScenarioCore";
import { readScoutSettings, settleScoutCall, startScoutCall } from "@/lib/productResearchScoutSettings";
import { recentSuggestionTitles } from "@/lib/productResearchScoutStore";

// The Scout's model-written task (docs/policy/product-research-agent.md §14).
// The walker posts here with no body when it holds today's `generated.explore`
// permit; the app asks the Scout's model for one realistic Chat request and
// answers it, and the walker sends it through the real composer. Off unless its
// own switch is set as well as the Scout's: off means this path does not exist.
// The model call is taken from the Scout's daily cap like every other subject.

export async function POST(request: Request) {
  if (!isProductResearchRouteEnabled(process.env, PRODUCT_RESEARCH_SCOUT_SWITCH_ENV)) return productResearchNotFound();
  if (!isProductResearchRouteEnabled(process.env, SCOUT_EXPLORE_TASK_ENV)) return productResearchNotFound();
  if (!isProductResearchRouteAuthorized(request, process.env, PRODUCT_RESEARCH_SCOUT_SECRET_ENV)) {
    return productResearchUnauthorized();
  }

  try {
    const answer = await runScenario({
      now: new Date(),
      recentTitles: () => recentSuggestionTitles(SCENARIO_FINDINGS_SUBJECT),
      model: async () => scoutLlmFor((await readScoutSettings()).modelId),
      // One call is kept for judging the turn this plans: with no room for it, no paid turn is made.
      reserve: (modelId) => startScoutCall({ subject: SCENARIO_SUBJECT, modelId, keepFree: SCENARIO_JUDGE_CALLS }),
      settle: settleScoutCall,
    });
    return productResearchJson(answer, "judged" in answer && answer.reason === "model_failed" ? 502 : 200);
  } catch (error) {
    return productResearchInternalError("product_research_scout_scenario", error);
  }
}
