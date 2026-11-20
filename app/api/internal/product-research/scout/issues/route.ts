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
import { ISSUE_TRIAGE_SUBJECT, PRODUCT_RESEARCH_SCOUT_ISSUE_TRIAGE_ENV, runIssueTriage } from "@/lib/productResearchScoutIssuesCore";
import { scoutLlmFor } from "@/lib/productResearchScoutLlm";
import { readScoutSettings, settleScoutCall, startScoutCall } from "@/lib/productResearchScoutSettings";
import { insertIssueSuggestions, latestObservationForTriage, recentlySuggestedIssues } from "@/lib/productResearchScoutStore";

// The Scout's issue-backlog subject (docs/policy/product-research-agent.md §10).
// The walker posts here once a run with no body; the app reads the newest
// product-research observation itself and asks the Scout's model for one
// close / proceed / wait suggestion per open issue. Off unless its own switch
// is set as well as the Scout's: off means this path does not exist. The model
// call is taken from the Scout's daily cap like every other subject.

export async function POST(request: Request) {
  if (!isProductResearchRouteEnabled(process.env, PRODUCT_RESEARCH_SCOUT_SWITCH_ENV)) return productResearchNotFound();
  if (!isProductResearchRouteEnabled(process.env, PRODUCT_RESEARCH_SCOUT_ISSUE_TRIAGE_ENV)) return productResearchNotFound();
  if (!isProductResearchRouteAuthorized(request, process.env, PRODUCT_RESEARCH_SCOUT_SECRET_ENV)) {
    return productResearchUnauthorized();
  }

  try {
    const answer = await runIssueTriage({
      now: new Date(),
      latestObservation: latestObservationForTriage,
      alreadySuggested: recentlySuggestedIssues,
      model: async () => scoutLlmFor((await readScoutSettings()).modelId),
      reserve: (modelId) => startScoutCall({ subject: ISSUE_TRIAGE_SUBJECT, modelId }),
      settle: settleScoutCall,
      insert: (modelId, suggestions) => insertIssueSuggestions({ modelId, suggestions }),
    });
    return productResearchJson(answer, !answer.judged && answer.reason === "model_failed" ? 502 : 200);
  } catch (error) {
    return productResearchInternalError("product_research_scout_issues", error);
  }
}
