// Compares fal's published price against the one this repository sells against.
//
// The reasoning lives in scripts/check-fal-image-pricing-core.mjs; this is the
// part that talks to the network, kept separate so the comparison can be tested
// against fixtures rather than against fal's mood.
//
//   npm run check:fal-image-pricing
//
// Reads FAL_KEY when it is set and skips the call when it is not, which is
// correct only while the model is disabled -- the core turns that same absence
// into a failure the moment it is enabled.
//
// Deliberately not wired into /api/ready. A price lookup that can 503 the
// service would stop chat and two working image providers over fal being slow.

import { getImageModel } from "../lib/imageModelRegistry.ts";
import {
  evaluateFalPricing,
  falPricingRequest,
} from "./check-fal-image-pricing-core.mjs";

const MODEL_ID = "fal-ai/nano-banana-2";
const PRICING_URL = "https://api.fal.ai/v1/models/pricing";

// Not an error when absent. The scheduled workflow runs this against `main`
// and `develop`, and between an activation landing on one and reaching the
// other, a branch legitimately has no such model. The core reports that as
// `not_registered` rather than as a failure.
const model = getImageModel(MODEL_ID) ?? null;

const { endpointId } = model ? falPricingRequest(model) : { endpointId: null };
const apiKey = process.env.FAL_KEY?.trim();

let response = null;
let reachError = null;
if (apiKey && endpointId) {
  try {
    const url = `${PRICING_URL}?endpoint_id=${encodeURIComponent(endpointId)}`;
    const result = await fetch(url, {
      headers: { Authorization: `Key ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!result.ok) {
      reachError = `fal's pricing API answered HTTP ${result.status}`;
    } else {
      response = await result.json();
    }
  } catch (error) {
    reachError = `fal's pricing API could not be reached: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

const verdict = evaluateFalPricing({ model, response, reachError });

console.log(`fal image pricing check: ${MODEL_ID} -- ${verdict.status}`);
if (!apiKey && model) {
  console.log("  FAL_KEY is not set, so no lookup was attempted.");
}
for (const note of verdict.notes) console.log(`  ${note}`);

if (verdict.problems.length > 0) {
  console.error(`\n${verdict.problems.length} problem(s):`);
  for (const problem of verdict.problems) console.error(`  - ${problem}`);
  console.error(
    "\nThe approved credit was computed from a price that no longer holds.\n" +
      "Re-approve, or leave the model disabled. Nothing else in the service is\n" +
      "affected by this failing.\n"
  );
  process.exit(1);
}

if (verdict.status === "matched") {
  console.log("\nfal's published price matches the approved one.");
}
