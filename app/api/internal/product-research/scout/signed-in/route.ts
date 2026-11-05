export const dynamic = "force-dynamic";

import { ApiSecurityError, readLimitedText } from "@/lib/apiSecurity";
import {
  isProductResearchRouteAuthorized,
  isProductResearchRouteEnabled,
  productResearchInternalError,
  productResearchJson,
  productResearchNotFound,
  productResearchUnauthorized,
} from "@/lib/productResearchObservationRouteAuth";
import { PRODUCT_RESEARCH_SCOUT_SECRET_ENV, PRODUCT_RESEARCH_SCOUT_SWITCH_ENV } from "@/lib/productResearchScoutCore";
import { issueScoutSignedInAccess, scoutTestAccountEmail } from "@/lib/productResearchScoutSignedIn";
import { requestedScoutGenerations } from "@/lib/productResearchScoutSubjects";

// The walker asks here to come in as the test account
// (docs/policy/product-research-agent.md §14). With no test account named this
// path does not exist, like the switch being off. The answer is a short-lived
// session and today's generation permits, and it is never logged.

const BODY_MAX_BYTES = 2_048;

export async function POST(request: Request) {
  if (!isProductResearchRouteEnabled(process.env, PRODUCT_RESEARCH_SCOUT_SWITCH_ENV)) return productResearchNotFound();
  const email = scoutTestAccountEmail();
  if (!email) return productResearchNotFound();
  if (!isProductResearchRouteAuthorized(request, process.env, PRODUCT_RESEARCH_SCOUT_SECRET_ENV)) {
    return productResearchUnauthorized();
  }

  let body: unknown;
  try {
    body = JSON.parse(await readLimitedText(request, BODY_MAX_BYTES));
  } catch (error) {
    const tooLarge = error instanceof ApiSecurityError && error.code === "REQUEST_BODY_TOO_LARGE";
    return productResearchJson({ refused: tooLarge ? "body_too_large" : "invalid_request" }, tooLarge ? 413 : 400);
  }

  try {
    const access = await issueScoutSignedInAccess(email, requestedScoutGenerations(body));
    return productResearchJson(access, "refused" in access ? 409 : 200);
  } catch (error) {
    return productResearchInternalError("product_research_scout_signed_in", error);
  }
}
