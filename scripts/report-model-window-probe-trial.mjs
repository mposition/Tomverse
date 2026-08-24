// Does an oversized *input* make a provider name its context window? A trial.
//
//   npm run report:model-window-probe-trial -- --model=perplexity/sonar
//   npm run report:model-window-probe-trial -- --model=perplexity/sonar --send
//   npm run report:model-window-probe-trial -- --model=perplexity/sonar --send --max-output-tokens=32
//
// `report:model-max-output-probe` asked for an impossible number of completion
// tokens and every provider answered with a `max_tokens` ceiling instead of a
// window, because that is the only thing the field it validates knows about.
// The remaining idea is the other half: send more input than any window holds
// and read the refusal.
//
// Whether that works is unknown, which is why this is a trial and why it takes
// one model at a time. Three ways a run can end without answering:
//
//   - the provider refuses without naming a number ("input too long"), in
//     which case the technique is dead and this script should be deleted
//     rather than left around looking useful;
//   - the provider accepts, meaning the input did not actually exceed the
//     window, and the next attempt needs a larger one;
//   - the provider refuses the *request* rather than the input -- a cap below
//     its floor, a bad key, an unknown model -- in which case nothing was
//     tested and the run is repeated once the request is right.
//
// Only the first of those says anything about the technique, so the script
// classifies the answer before drawing any conclusion from it. It did not, on
// its first outing, and reported the third case as the first: see
// ./report-model-window-probe-trial-core.mjs.
//
// If it does name a window, this graduates into a probe over all the remaining
// models and the trial framing goes away.
//
// ## This one costs real money, unlike the max-output probe
//
// A cap that is out of range is rejected on validation, before any tokens are
// counted. An oversized *input* is different: the provider has to tokenise
// what it was sent to know it is too long, and providers bill for input
// tokens. A 150,000-token probe is a 150,000-token bill if the provider counts
// before it refuses -- and if it *accepts*, it also runs inference.
//
// So: one model, one request, `--send` required, and the size is chosen by the
// operator rather than defaulted into something expensive by accident.
//
// ## It reports; it does not decide
//
// Same standing as the other two probes. Nothing is written to lib/models.ts
// or to the register, which wants `sourceUrl`, `sourceTitle`, `verifiedAt` and
// `verifiedBy` before a row may carry a number.

import {
  errorMessageFrom,
  parseLimitCandidates,
  probeRequestFor,
} from "./report-model-max-output-probe-core.mjs";
import {
  DEFAULT_COMPLETION_CAP,
  classifyTrialAnswer,
} from "./report-model-window-probe-trial-core.mjs";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import { PROVIDER_API_CONFIGURATION } from "../lib/modelRegistryShared.ts";

const args = process.argv.slice(2);
const send = args.includes("--send");
const modelId = args.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);
const approxTokens = Number(
  args.find((arg) => arg.startsWith("--approx-input-tokens="))?.slice("--approx-input-tokens=".length) ||
    150_000
);
const completionCap = Number(
  args.find((arg) => arg.startsWith("--max-output-tokens="))?.slice("--max-output-tokens=".length) ||
    DEFAULT_COMPLETION_CAP
);
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS || 120_000);

if (!modelId) {
  console.error(
    "--model=<id> is required. This trial asks one model at a time on purpose:\n" +
      "an oversized input is billed as input tokens, so a sweep would be a bill.\n\n" +
      "Models with no declared context window:\n" +
      AVAILABLE_MODELS.filter(
        (model) => model.enabled && !model.catalogDeleted && !model.contextWindowTokens
      )
        .map((model) => `  ${model.id}`)
        .join("\n")
  );
  process.exit(1);
}

const model = AVAILABLE_MODELS.find((entry) => entry.id === modelId);
if (!model) {
  console.error(`No catalogue model "${modelId}".`);
  process.exit(1);
}
if (!Number.isFinite(approxTokens) || approxTokens < 1_000) {
  console.error("--approx-input-tokens must be a number of at least 1000.");
  process.exit(1);
}
if (!Number.isInteger(completionCap) || completionCap < 1) {
  console.error("--max-output-tokens must be a whole number of at least 1.");
  process.exit(1);
}

const configuration = PROVIDER_API_CONFIGURATION[model.provider];
if (!configuration) {
  console.error(`No API configuration for provider "${model.provider}".`);
  process.exit(1);
}

let request;
try {
  request = probeRequestFor({
    provider: model.provider,
    apiModel: model.apiModel,
    baseUrl: configuration.baseUrl,
    protocol: configuration.protocol,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// One common word per repetition. Most tokenisers give a leading-space word a
// single token, so the repetition count is roughly the token count -- roughly
// being the operative word, which is why the flag is named `approx` and why
// overshooting is the right instinct. Content-free by construction: this is
// filler the script generates, never anything a user wrote.
const filler = "the ".repeat(approxTokens).trim();
const body = {
  ...request.body,
  messages: [{ role: "user", content: filler }],
  // Small, because this is the length of the reply that gets billed if the
  // input turns out to fit after all. Not one, though: a cap under a
  // provider's floor is refused on validation, and that refusal arrives before
  // the input is ever counted -- a run that tests nothing while looking like a
  // result.
  [request.capField]: completionCap,
};
const payloadBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
const apiKey = process.env[configuration.apiKeyEnvName];

console.log(`Context window trial — ${model.id} (${model.provider} ${model.apiModel})\n`);
console.log(`  POST ${request.url}`);
console.log(`  ~${approxTokens.toLocaleString("en-US")} input tokens, ${(payloadBytes / 1_048_576).toFixed(1)} MiB of body`);
console.log(`  ${request.capField}: ${completionCap}`);
console.log(
  `  key from ${configuration.apiKeyEnvName}: ${apiKey ? "present" : "MISSING — this would fail on auth, not on the window"}`
);

if (!send) {
  console.log(
    "\nNothing was sent. Re-run with --send.\n\n" +
      "Before you do: this request is billed as input tokens if the provider counts\n" +
      "before refusing, and runs inference if it accepts. That is the difference\n" +
      "between this and the max-output probe, which is rejected on validation."
  );
  process.exit(0);
}

if (!apiKey) {
  console.error(`\n${configuration.apiKeyEnvName} is not set; refusing to send a request that can only fail on auth.`);
  process.exit(1);
}

let status = null;
let message = null;
try {
  const response = await fetch(request.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  status = response.status;
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A provider answering with HTML or a bare string is still telling us
    // something.
  }
  message = errorMessageFrom(parsed) ?? text.slice(0, 600);
} catch (error) {
  console.error(`\nNo answer: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

console.log(`\n  -> HTTP ${status}`);

const outcome = classifyTrialAnswer({ status, message });

if (outcome === "accepted") {
  console.log(
    "\n  ACCEPTED. The input fitted, so the window is larger than this request.\n" +
      "  Re-run with a bigger --approx-input-tokens, or stop: each attempt is billed.\n" +
      "  The technique is not disproved by this, only undersized."
  );
  process.exit(0);
}

console.log(`\n  ${message?.slice(0, 600) ?? "(no message)"}\n`);

if (outcome === "refusedOnCap") {
  console.log(
    `  This refusal is about ${request.capField}, not about the input. The request\n` +
      "  died on cap validation before the input was counted, so the trial did not\n" +
      "  run and nothing here bears on the technique.\n\n" +
      "  Re-run with --max-output-tokens set to the floor the provider just named.\n" +
      "  Keep it as small as that floor allows: it is the length of the reply that\n" +
      "  gets billed if the input turns out to fit."
  );
  process.exit(0);
}

if (outcome === "refusedForOtherReason") {
  console.log(
    "  This refusal names neither the input length nor the cap, so the trial did\n" +
      "  not run: a bad key, an unknown model, a rate limit, or wording this script\n" +
      "  does not recognise. Read it, fix the request, and ask again. Do not read a\n" +
      "  verdict on the technique into it -- that mistake is why this branch exists."
  );
  process.exit(0);
}

// Only a length refusal can carry a window, and only some of them name one.
// Both outcomes from here are the trial's actual result.
const candidates = parseLimitCandidates(message);

if (candidates.length === 0) {
  console.log(
    "  A refusal about length, with no token-sized number in it. On this evidence\n" +
      "  the technique does not answer the question for this provider, and a script\n" +
      "  that keeps asking would be one that costs money to learn nothing. Delete it,\n" +
      "  or try one more provider before deciding."
  );
} else {
  console.log("  Candidates:");
  for (const candidate of candidates) {
    console.log(`    ${candidate.tokens.toLocaleString("en-US").padStart(13)}  ...${candidate.phrase}...`);
  }
  console.log(
    "\n  Read the phrase beside each. A refusal about input length may name the\n" +
      "  window, the input it counted, or both -- and this trial exists to find out\n" +
      "  which, so do not take the largest number as the answer.\n\n" +
      "  If one of these is a window, this graduates into a probe over the remaining\n" +
      "  models. Nothing was written either way: the register wants sourceUrl,\n" +
      "  sourceTitle, verifiedAt and verifiedBy before a row may carry a number."
  );
}
