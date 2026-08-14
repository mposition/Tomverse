// Recomputes the fal activation evidence instead of believing it.
//
//   npm run check:fal-smoke-evidence
//
// `fal-ai/nano-banana-2` was enabled on the strength of one paid generation.
// That run is the only reason this repository knows -- rather than believes --
// that the request shape is accepted, the asset host is fal's CDN, the
// delivered MIME is storable and the image is the size that was priced. A
// single artefact carrying that much weight should not be trusted on the word
// of its own `outcome` field.
//
// So the verdict is recomputed from the recorded checks, and the recorded
// request is compared against what `buildFalImageRequest` builds *today*. That
// second comparison is the one that matters over time: change `thinking_level`
// or `aspect_ratio` and the evidence stops describing the request we actually
// make, while still reading as a pass. The proof would be stale and nothing
// else would notice.
//
// Fail-closed on the same condition as the price check: mandatory while the
// model is enabled, silent while it is held. Enabling a model is what makes
// its evidence load-bearing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildFalImageRequest } from "../lib/falImageRequest.ts";
import { getImageModel } from "../lib/imageModelRegistry.ts";

const MODEL_ID = "fal-ai/nano-banana-2";
const EVIDENCE = fileURLToPath(
  new URL(
    "../.github/audits/evidence/fal-nano-banana-2-smoke/2026-08-14-smoke.json",
    import.meta.url
  )
);

/**
 * Every gate the smoke script runs. Listed here rather than counted, because a
 * run that never reached a gate would otherwise pass this check with fewer
 * `ok`s and nothing to say so.
 */
const REQUIRED_CHECKS = [
  "response parses as exactly one image",
  "asset host is on fal's CDN",
  "delivered MIME is one we may store",
  "asset is served without a redirect off the allowed host",
  "declared length is within the ceiling",
  "downloaded size is within the ceiling",
  "delivered image is the size that was priced",
];

const model = getImageModel(MODEL_ID);
if (!model) {
  console.error(`${MODEL_ID} is not in the image model registry.`);
  process.exit(1);
}

const problems = [];
const notes = [];

if (model.disabledReason !== null) {
  console.log(
    `fal smoke evidence check: ${MODEL_ID} is disabled (${model.disabledReason}); ` +
      "its evidence is not load-bearing and was not checked."
  );
  process.exit(0);
}

let evidence;
try {
  evidence = JSON.parse(readFileSync(EVIDENCE, "utf8"));
} catch (error) {
  console.error(
    `${MODEL_ID} is enabled but its smoke evidence could not be read ` +
      `(${error instanceof Error ? error.message : String(error)}).\n` +
      "Re-run `npm run smoke:fal-image` and commit the result, or disable the model."
  );
  process.exit(1);
}

// --- 1. the verdict, recomputed -----------------------------------------

const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
const recomputed =
  checks.length > 0 && checks.every((check) => check.ok === true)
    ? "passed"
    : "failed";
if (evidence.outcome !== recomputed) {
  problems.push(
    `the file says "${evidence.outcome}" but its own checks recompute to "${recomputed}"`
  );
}
if (recomputed !== "passed") {
  problems.push(
    `not every gate passed: ${checks
      .filter((check) => !check.ok)
      .map((check) => check.name)
      .join(", ")}`
  );
}

for (const name of REQUIRED_CHECKS) {
  if (!checks.some((check) => check.name === name)) {
    problems.push(`the run never reached the gate "${name}"`);
  }
}

if (evidence.httpStatus !== 200) {
  problems.push(`the request answered HTTP ${evidence.httpStatus}`);
}
if (evidence.responseShape?.imageCount !== 1) {
  problems.push(
    `the response carried ${evidence.responseShape?.imageCount} images; the price is for one`
  );
}

// --- 2. the request it proves is the request we still make ---------------

const built = buildFalImageRequest({
  prompt: "x",
  size: evidence.size,
  outputFormat: evidence.requestBody?.output_format,
});
if (!built) {
  problems.push(
    `the builder now refuses ${evidence.size} / ${evidence.requestBody?.output_format}, ` +
      "so the evidence describes a request this code no longer makes"
  );
} else {
  // Compared as whole objects, minus the prompt the evidence digests. An
  // added, removed or altered field all fail, which is the point: the Google
  // adapter carried an invented `delivery` key for weeks because every check
  // looked at fields it already knew about.
  const recordedFields = { ...(evidence.requestBody ?? {}) };
  const builtFields = { ...built };
  delete recordedFields.prompt;
  delete builtFields.prompt;
  const recorded = JSON.stringify(recordedFields, Object.keys(recordedFields).sort());
  const current = JSON.stringify(builtFields, Object.keys(recordedFields).sort());
  if (
    recorded !== current ||
    Object.keys(recordedFields).sort().join() !== Object.keys(builtFields).sort().join()
  ) {
    problems.push(
      "the request the evidence proves is not the request the builder produces today:\n" +
        `      evidence: ${JSON.stringify(recordedFields)}\n` +
        `      builder:  ${JSON.stringify(builtFields)}`
    );
  }
}

// --- 3. what was actually billed ----------------------------------------

const price = model.prices.find((entry) => entry.size === evidence.size);
const billableUnits = Number(evidence.responseHeaders?.["x-fal-billable-units"]);
if (!price) {
  problems.push(`the registry carries no price for ${evidence.size}`);
} else if (!Number.isFinite(billableUnits) || billableUnits <= 0) {
  // Not fatal on its own -- the gates are what gate activation -- but it is
  // the only record of what the money did, so its absence is stated.
  notes.push(
    "fal reported no billable units, so the charge could not be reconciled against the approved worst case."
  );
} else {
  const billedMicroUsd = Math.round(billableUnits * price.outputCostMicroUsd);
  // fal's share of the approved worst case, and only fal's: the 5,000 prompt
  // budget in policy section 16.4 is padding this repository adds to every
  // model's floor, not something fal charges for.
  const falWorstCase =
    price.outputCostMicroUsd + (model.priceVerification.thinkingCapMicroUsd ?? 0);
  notes.push(
    `fal billed ${billableUnits} units = ${billedMicroUsd} microUSD ` +
      `against a fal-side worst case of ${falWorstCase} ` +
      `(${price.outputCostMicroUsd} image + ${model.priceVerification.thinkingCapMicroUsd} high thinking).`
  );
  if (billedMicroUsd > falWorstCase) {
    problems.push(
      `fal billed ${billedMicroUsd} microUSD, above the approved fal-side worst case of ${falWorstCase}. ` +
        "A surcharge the request was supposed to pin off, or a retry, would look exactly like this."
    );
  }
}

// --- 4. the evidence is not itself a leak -------------------------------

const raw = readFileSync(EVIDENCE, "utf8");
if (!/^sha256:[0-9a-f]{16,}$/.test(evidence.promptSha256 ?? "")) {
  problems.push("the prompt is not stored as a digest");
}
if (evidence.requestBody?.prompt !== evidence.promptSha256) {
  problems.push("the recorded request body carries prompt text rather than the digest");
}
if (/https?:\/\/[^"]*\.fal\.media\//.test(raw)) {
  problems.push(
    "a whole asset URL is stored; it is a publicly readable link to a generated image"
  );
}

console.log(`fal smoke evidence check: ${MODEL_ID}`);
for (const note of notes) console.log(`  ${note}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nThe model is enabled on the strength of this run. Re-run\n" +
      "`npm run smoke:fal-image`, or disable the model.\n"
  );
  process.exit(1);
}

console.log("\nThe evidence still supports enabling the model.");
