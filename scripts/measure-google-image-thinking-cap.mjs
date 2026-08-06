// Does `max_output_tokens` bound hidden thinking?
//
//   node --import tsx scripts/measure-google-image-thinking-cap.mjs --help
//   node --import tsx scripts/measure-google-image-thinking-cap.mjs \
//     --model=gemini-3.1-flash-lite-image --limit=512 --repeats=3 \
//     --i-accept-the-cost
//
// That is the entire question, and it is the one thing keeping all three
// Google image models disabled. The 2026-08-05 documentation review closed it
// as a checked absence: the Interactions API reference defines
// `generation_config.max_output_tokens` as the maximum tokens to include in
// the response and reports `usage.total_output_tokens` and
// `usage.total_thought_tokens` as separate counters; the thinking guide
// describes the charge as their sum without saying the limit covers it. The
// model card's output limit bounds the same undefined quantity, so it cannot
// supply the link either. Policy §12 forbids promoting a forum answer, a
// search summary or a relayed confirmation to `verified`, so the remaining
// evidence is the billing signal itself.
//
// EVERY RUN SPENDS MONEY. Each repeat is a real image generation on a real
// key. That is why the run needs an explicit flag it cannot be given by
// accident, and why policy §15 requires the evaluation budget to be approved
// before it happens. Nothing here writes to the database, the registry or any
// artefact -- it prints, and a human records the result.
//
// What a pass looks like, and what it does not:
//
//   * PASS means `total_output_tokens + total_thought_tokens <= limit` on
//     every sample, INCLUDING at a limit low enough that some sample actually
//     hit it. A run whose samples all finished far under the ceiling shows
//     that the model is economical, not that the ceiling is enforced -- the
//     report says so rather than counting it.
//   * `usage.total_tokens` includes the input and is never compared with the
//     limit. It is printed only so the arithmetic can be checked by hand.
//   * One passing run is not the verification. Policy §12 wants the worst
//     case, so this is meant to be run per model, at more than one limit, with
//     prompts complex enough to provoke thinking, and its JSON kept as
//     evidence.

import { getImageModel, IMAGE_MODEL_REGISTRY } from "../lib/imageModelRegistry.ts";
import {
  buildGoogleImageRequest,
  googleBillableOutputTokens,
  GOOGLE_API_KEY_HEADER,
  GOOGLE_INTERACTIONS_URL,
  parseGoogleImageResponse,
} from "../lib/googleImageRequest.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const googleModels = IMAGE_MODEL_REGISTRY.filter(
  (model) => model.provider === "google"
);

// `npm run <script> --model=x` without the `--` separator makes npm treat the
// flags as its own config and pass the script nothing. That used to fall
// through to the help text, which reads as "you forgot the arguments" to
// someone who did not -- and this is a script people run having just arranged
// to spend money. npm records what it swallowed in npm_config_*, so the
// mistake is detectable and worth naming.
const swallowedByNpm = ["model", "limit", "repeats", "thinking", "prompt"]
  .filter((name) => process.env[`npm_config_${name}`] !== undefined);

if (args.length === 0 && swallowedByNpm.length > 0) {
  console.error(
    [
      "npm consumed the arguments instead of passing them on:",
      ...swallowedByNpm.map((name) => `  --${name}`),
      "",
      "`npm run` needs `--` before the script's own flags:",
      "",
      "  npm run measure:google-image-thinking-cap -- --model=... --limit=...",
      "",
      "Or skip npm entirely:",
      "",
      "  node --conditions=react-server --import tsx \\",
      "    scripts/measure-google-image-thinking-cap.mjs --model=... --limit=...",
      "",
      "Nothing was sent.",
    ].join("\n")
  );
  process.exit(1);
}

if (flag("help") || args.length === 0) {
  console.log(
    [
      "Measures whether Google's max_output_tokens bounds hidden thinking.",
      "",
      "  --model=<id>            one of:",
      ...googleModels.map(
        (model) => `                            ${model.id} (card limit ${model.maxOutputTokens})`
      ),
      "  --limit=<n>             max_output_tokens to request (default: the card limit)",
      "  --repeats=<n>           samples, 1-10 (default 3). EACH ONE IS A PAID IMAGE.",
      "  --thinking=<level>      low|medium|high, omitted unless given",
      "  --prompt=<text>         override the built-in provocative prompt",
      "  --json                  machine-readable output for the evidence file",
      "  --i-accept-the-cost     required; without it nothing is sent",
      "",
      "Start with the lowest card limit (gemini-3.1-flash-lite-image, 4096) and",
      "a --limit well under it: a ceiling that never binds proves nothing.",
    ].join("\n")
  );
  process.exit(0);
}

const modelId = value("model");
const model = modelId ? getImageModel(modelId) : null;
if (!model || model.provider !== "google") {
  console.error(
    `--model must name a registered Google image model (${googleModels
      .map((entry) => entry.id)
      .join(", ")}).`
  );
  process.exit(1);
}

const limit = Number(value("limit") ?? model.maxOutputTokens);
if (!Number.isSafeInteger(limit) || limit <= 0) {
  console.error("--limit must be a positive integer.");
  process.exit(1);
}
const repeats = Number(value("repeats") ?? 3);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) {
  console.error("--repeats must be between 1 and 10. Every repeat is billed.");
  process.exit(1);
}
const thinkingLevel = value("thinking");
if (thinkingLevel && !["low", "medium", "high"].includes(thinkingLevel)) {
  console.error("--thinking must be low, medium or high.");
  process.exit(1);
}

// Deliberately elaborate: a trivial prompt produces little thinking, and a run
// that never approaches the ceiling cannot tell an enforced limit from a model
// that simply did not need the room.
const DEFAULT_PROMPT =
  "A cutaway technical illustration of a mechanical wristwatch movement, " +
  "labelled in English, showing the mainspring barrel, the going train, the " +
  "escapement and the balance wheel, with each label connected to its part by " +
  "a thin leader line, drawn in the style of a 1950s engineering manual.";
const prompt = value("prompt") ?? DEFAULT_PROMPT;

const apiKey =
  process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
  process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.error(
    "GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY) is not set."
  );
  process.exit(1);
}

const body = buildGoogleImageRequest({
  apiModelId: model.apiModelId,
  prompt,
  size: "1024x1024",
  maxOutputTokens: limit,
  thinkingLevel: thinkingLevel ?? model.thinkingLevel ?? null,
  deliveryMimeType: model.outputMimeTypes[0] ?? "image/png",
});
if (!body) {
  console.error("The request builder refused these parameters.");
  process.exit(1);
}

if (!flag("i-accept-the-cost")) {
  console.error(
    [
      `Would send ${repeats} paid image generation(s) to ${model.id} at`,
      `max_output_tokens=${limit}. Nothing was sent.`,
      "",
      "Re-run with --i-accept-the-cost once the evaluation budget is approved",
      "(policy docs/policy/image-generation.md §15).",
    ].join("\n")
  );
  process.exit(1);
}

/**
 * Everything printed goes through here. A Google API key turns up in echoed
 * headers and in some error bodies, and the prompt is user-shaped content that
 * policy §10 keeps out of logs -- so the report carries a hash of it, never
 * the text.
 */
const redact = (text) =>
  String(text)
    // Google issues more than one key shape (`AIza...`, `AQ....`), so the
    // pattern is a backstop for keys OTHER than the one in hand -- the exact
    // value is replaced below regardless, which is what actually guarantees
    // this output can be pasted into a ticket.
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, "[redacted-api-key]")
    .replace(/\bAQ\.[A-Za-z0-9_-]{10,}/g, "[redacted-api-key]")
    .replace(new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[redacted-api-key]");

const { createHash } = await import("node:crypto");
const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);

const samples = [];
for (let index = 0; index < repeats; index += 1) {
  const startedAt = new Date().toISOString();
  let response;
  try {
    response = await fetch(GOOGLE_INTERACTIONS_URL, {
      method: "POST",
      headers: {
        [GOOGLE_API_KEY_HEADER]: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
    });
  } catch (error) {
    samples.push({
      index,
      startedAt,
      outcome: "request_failed",
      detail: redact(error instanceof Error ? error.message : String(error)),
    });
    continue;
  }

  const text = await response.text();
  if (!response.ok) {
    samples.push({
      index,
      startedAt,
      outcome: "http_error",
      status: response.status,
      detail: redact(text).slice(0, 300),
    });
    continue;
  }

  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    samples.push({ index, startedAt, outcome: "unparseable_body" });
    continue;
  }

  const parsed = parseGoogleImageResponse(payload);
  // A refusal here is itself a finding: it means the response shape is not the
  // one the adapter was written against, which has to be resolved before any
  // number from this run means anything.
  if (!parsed) {
    samples.push({
      index,
      startedAt,
      outcome: "unreadable_payload",
      // Enough to see the shape, never enough to reconstitute an image.
      topLevelKeys: Object.keys(payload ?? {}),
      stepTypes: Array.isArray(payload?.steps)
        ? payload.steps.map((step) => step?.type ?? null)
        : null,
    });
    continue;
  }

  const billable = googleBillableOutputTokens(parsed.usage);
  samples.push({
    index,
    startedAt,
    outcome: "ok",
    responseId: payload?.id ?? payload?.name ?? null,
    inputTokens: parsed.usage.inputTokens,
    outputTokens: parsed.usage.outputTokens,
    thinkingTokens: parsed.usage.thinkingTokens,
    billableOutputTokens: billable,
    withinLimit: billable <= limit,
    // Printed only so the arithmetic can be checked by hand. It includes the
    // input, so it is never the number compared with the limit.
    reportedTotalTokens: payload?.usage?.total_tokens ?? null,
    // A response that stopped because it ran out of room is the sample that
    // actually demonstrates enforcement.
    finishReason:
      payload?.status ?? payload?.finish_reason ?? payload?.stop_reason ?? null,
    mimeType: parsed.mimeType,
  });
}

const ok = samples.filter((sample) => sample.outcome === "ok");
const exceeded = ok.filter((sample) => !sample.withinLimit);
// "Bit" = a sample that got close enough to the ceiling that staying under it
// is evidence of a limit rather than of modest usage. 90% is a judgement call
// and is stated so the reader can disagree with it.
const bit = ok.filter((sample) => sample.billableOutputTokens >= limit * 0.9);

const verdict = (() => {
  if (ok.length === 0) return "inconclusive_no_samples";
  if (exceeded.length > 0) return "limit_does_not_bound_thinking";
  if (bit.length === 0) return "inconclusive_limit_never_bound";
  return "consistent_with_limit_bounding_thinking";
})();

const report = {
  measuredAt: new Date().toISOString(),
  modelId: model.id,
  apiModelId: model.apiModelId,
  cardOutputLimit: model.maxOutputTokens ?? null,
  requestedMaxOutputTokens: limit,
  thinkingLevel: thinkingLevel ?? model.thinkingLevel ?? null,
  promptSha256Prefix: promptHash,
  repeats,
  samples,
  verdict,
};

if (flag("json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Model:      ${model.id}`);
  console.log(`Limit sent: ${limit} (card limit ${model.maxOutputTokens})`);
  console.log(`Prompt:     sha256:${promptHash} (text withheld -- policy §10)`);
  console.log("");
  for (const sample of samples) {
    if (sample.outcome !== "ok") {
      console.log(`  #${sample.index}  ${sample.outcome}${sample.status ? ` (${sample.status})` : ""}`);
      continue;
    }
    console.log(
      `  #${sample.index}  output ${sample.outputTokens} + thinking ${sample.thinkingTokens}` +
        ` = ${sample.billableOutputTokens} vs limit ${limit}` +
        `  ${sample.withinLimit ? "within" : "OVER"}`
    );
  }
  console.log("");
  console.log(`Verdict: ${verdict}`);
  if (verdict === "inconclusive_limit_never_bound") {
    console.log(
      "  Every sample finished well under the ceiling. That shows the model is" +
        "\n  economical, not that the ceiling is enforced. Re-run with a lower" +
        "\n  --limit until some sample approaches it."
    );
  }
  if (verdict === "limit_does_not_bound_thinking") {
    console.log(
      "  A sample billed more output+thinking than the limit allowed. The" +
        "\n  worst case is not bounded by this parameter and the models stay" +
        "\n  worst_case_cost_unbounded."
    );
  }
  console.log("");
  console.log(
    "Not a verification on its own: policy §12 wants the worst case, so run" +
      "\nthis per model, at more than one limit, and keep the --json output as" +
      "\nevidence. Nothing was written anywhere."
  );
}

process.exit(verdict === "limit_does_not_bound_thinking" ? 1 : 0);
