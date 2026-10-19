export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { ApiSecurityError, readLimitedText } from "@/lib/apiSecurity";
import {
  isProductResearchRouteAuthorized,
  isProductResearchRouteEnabled,
  productResearchInternalError,
  productResearchJson,
  productResearchNotFound,
  productResearchUnauthorized,
} from "@/lib/productResearchObservationRouteAuth";
import {
  PRODUCT_RESEARCH_SCOUT_SECRET_ENV,
  PRODUCT_RESEARCH_SCOUT_SWITCH_ENV,
  SCOUT_SUBMISSION_MAX_BYTES,
  admitScoutSubmission,
} from "@/lib/productResearchScoutCore";
import { productResearchScoutLlmFromEnv } from "@/lib/productResearchScoutLlm";
import { insertSuggestions, recentSuggestionTitles } from "@/lib/productResearchScoutStore";

// The product-research scout's one route (owner direction 2026-10-19,
// LLM-first). The walker posts one subject -- a page's screenshots, a
// generated file's image, or the catalogue's mismatches -- and the app asks the
// model what is worth improving, then stores what it says.
//
// The switch comes first (off means this path does not exist), then the
// secret, then the body. The model call is the only paid step and is off until
// PRODUCT_RESEARCH_SCOUT_LLM_MODEL_ID names a model.

export async function POST(request: Request) {
  if (!isProductResearchRouteEnabled(process.env, PRODUCT_RESEARCH_SCOUT_SWITCH_ENV)) return productResearchNotFound();
  if (!isProductResearchRouteAuthorized(request, process.env, PRODUCT_RESEARCH_SCOUT_SECRET_ENV)) {
    return productResearchUnauthorized();
  }

  let body: unknown;
  try {
    body = JSON.parse(await readLimitedText(request, SCOUT_SUBMISSION_MAX_BYTES));
  } catch (error) {
    const tooLarge = error instanceof ApiSecurityError && error.code === "REQUEST_BODY_TOO_LARGE";
    return productResearchJson({ refused: tooLarge ? "body_too_large" : "invalid_request" }, tooLarge ? 413 : 400);
  }
  const admission = admitScoutSubmission(body);
  if (!admission.ok) return productResearchJson({ refused: admission.code }, 400);
  const { submission } = admission;

  const llm = await productResearchScoutLlmFromEnv();
  if (!llm) return productResearchJson({ judged: false, reason: "model_off" });

  try {
    const existing = await recentSuggestionTitles(submission.subject);
    const suggestions = await llm.judge(submission, existing);
    if (suggestions === null) return productResearchJson({ judged: false, reason: "model_failed" }, 502);
    const stored = await insertSuggestions({
      kind: submission.kind,
      subject: submission.subject,
      modelId: llm.modelId,
      suggestions,
    });
    return productResearchJson({ judged: true, stored });
  } catch (error) {
    return productResearchInternalError("product_research_scout", error);
  }
}
