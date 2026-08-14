// Does `max_output_tokens` bound what Google bills?
//
// ANSWERED, NEGATIVELY, ON 2026-08-14. A request to
// gemini-3.1-flash-lite-image with `max_output_tokens: 2048` reported 1,602
// output plus 931 thinking -- 2,533 -- as billable usage and returned a
// finished image. The parameter is a request parameter, not a cost ceiling.
// The three Google image models keep `worst_case_cost_unbounded` and
// `thinkingCapMicroUsd` stays null. Full result and all eighteen samples:
// .github/audits/image-model-verification-worksheet.md §I.
//
// This script is kept because the question can reopen -- a new model, a new
// parameter, a documented bound -- and because rebuilding a measurement that
// spends money is worse than keeping one that has been through four limits.
// It is not a route out of the disabled state on its own: policy §12 wants a
// finite worst case, and running this again against the same parameter would
// re-measure a settled question.
//
//   node --import tsx scripts/measure-google-image-thinking-cap.mjs --help
//   node --import tsx scripts/measure-google-image-thinking-cap.mjs \
//     --model=gemini-3.1-flash-lite-image --limit=512 --repeats=3 \
//     --i-accept-the-cost
//
// The question it was built for, and how it came to be asked. The 2026-08-05
// documentation review closed the documentary side as a checked absence: the Interactions API reference defines
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
//   * A sample with no finished image still counts. Running out of room before
//     completing one is the clearest evidence the limit binds, and reading the
//     response only through the production parser -- which fails closed on
//     anything that is not exactly one image -- discarded exactly those.
//   * Samples from a single prompt cannot support the affirmative verdict.
//     How much a model thinks depends on what it was asked, so one prompt
//     repeated is one prompt's evidence (policy §12).
//   * `usage.total_tokens` includes the input and is never compared with the
//     limit. It is printed only so the arithmetic can be checked by hand.
//   * One passing run is not the verification. Policy §12 wants the worst
//     case, so this is meant to be run per model, at more than one limit, with
//     prompts complex enough to provoke thinking, and its JSON kept as
//     evidence.

import {
  getImageModel,
  imageDeliveryMimeType,
  IMAGE_MODEL_REGISTRY,
} from "../lib/imageModelRegistry.ts";
import { writeFileSync } from "node:fs";

import {
  redactGoogleImageRequestBody,
  redactGoogleImageResponseBody,
} from "../lib/googleImageEvidence.ts";
import {
  buildGoogleImageRequest,
  googleBillableOutputTokens,
  GOOGLE_API_KEY_HEADER,
  GOOGLE_INTERACTIONS_URL,
  parseGoogleImageResponse,
  readGoogleImageInteraction,
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
const swallowedByNpm = ["model", "limit", "repeats", "thinking", "prompt", "prompts"]
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

// Every argument has to be one this script knows. An unrecognised one used to
// be ignored, and on 2026-08-14 `-repeats=2` -- one hyphen instead of two --
// was ignored exactly that way: `repeats` fell back to its default of 3 and the
// run sent six paid requests where four were intended and budgeted. A flag that
// silently does nothing is bad everywhere and worse here, because the feedback
// is an invoice.
const VALUELESS_FLAGS = new Set(["help", "json", "i-accept-the-cost"]);
const VALUED_FLAGS = new Set([
  "model",
  "limit",
  "repeats",
  "prompts",
  "thinking",
  "prompt",
  "out",
]);

const unknownArgs = args.filter((arg) => {
  if (!arg.startsWith("--")) return true;
  const name = arg.slice(2).split("=")[0];
  return arg.includes("=")
    ? !VALUED_FLAGS.has(name)
    : !VALUELESS_FLAGS.has(name);
});

if (unknownArgs.length > 0) {
  const singleHyphen = unknownArgs.filter(
    (arg) => arg.startsWith("-") && !arg.startsWith("--")
  );
  console.error(
    [
      `Unrecognised argument(s): ${unknownArgs.join(" ")}`,
      ...(singleHyphen.length > 0
        ? [
            "",
            `Every flag here takes two hyphens. ${singleHyphen
              .map((arg) => `\`${arg}\` should be \`-${arg}\``)
              .join(", ")}.`,
          ]
        : []),
      ...(VALUED_FLAGS.has(unknownArgs[0]?.replace(/^--/, ""))
        ? ["", "That flag takes a value: write --name=value, not --name value."]
        : []),
      "",
      "Refused rather than ignored: an argument that does nothing silently",
      "changes how many paid requests this sends. Nothing was sent.",
      "",
      "Run with --help for the full list.",
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
      "  --repeats=<n>           rounds, 1-10 (default 3)",
      "  --prompts=<n>           built-in prompts to use, 1-2 (default 1)",
      "  --thinking=<level>      low|medium|high, omitted unless given",
      "  --prompt=<text>         one custom prompt instead of the built-in set",
      "  --json                  machine-readable output for the evidence file",
      "  --out=<path>            write the evidence JSON here after every sample",
      "  --i-accept-the-cost     required; without it nothing is sent",
      "",
      "PAID IMAGES = --prompts x --repeats. Each one is a real generation on a",
      "real key. The run stops early on the first sample over the limit, or on",
      "the first unreadable response.",
      "",
      "--limit is any positive integer, not a value from a table. The card limit",
      "is only its default. The example uses --limit=512 against a 4,096 card",
      "limit deliberately: the question is whether the parameter is enforced, and",
      "a ceiling the model never comes near cannot answer it either way. Walk it",
      "down (2048, 1024, 512) until a sample approaches or hits the ceiling, and",
      "start with the lowest card limit (gemini-3.1-flash-lite-image, 4096).",
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

// Deliberately elaborate, and deliberately more than one: a trivial prompt
// produces little thinking, and a run that never approaches the ceiling cannot
// tell an enforced limit from a model that simply did not need the room.
// Policy §12 asks for "several complex prompts" -- one prompt repeated is one
// prompt's worth of evidence however many times it is sent, because the
// thinking a model does is a function of what it was asked. The two differ in
// what they make expensive: the first is dense labelled geometry, the second
// is multilingual text rendering with a counting constraint.
const BUILT_IN_PROMPTS = [
  "A cutaway technical illustration of a mechanical wristwatch movement, " +
    "labelled in English, showing the mainspring barrel, the going train, the " +
    "escapement and the balance wheel, with each label connected to its part by " +
    "a thin leader line, drawn in the style of a 1950s engineering manual.",
  "A vintage railway departure board photographed head-on, listing exactly six " +
    "services with their platform numbers and departure times, every row " +
    "written twice -- once in English and once in Korean -- with the third row " +
    "marked as delayed and the board's split-flap characters mid-rotation.",
];

const customPrompt = value("prompt");
const promptCount = Number(value("prompts") ?? 1);
if (
  !customPrompt &&
  (!Number.isSafeInteger(promptCount) ||
    promptCount < 1 ||
    promptCount > BUILT_IN_PROMPTS.length)
) {
  console.error(
    `--prompts must be between 1 and ${BUILT_IN_PROMPTS.length}. ` +
      "Every prompt multiplies the number of paid images by --repeats."
  );
  process.exit(1);
}
const prompts = customPrompt
  ? [customPrompt]
  : BUILT_IN_PROMPTS.slice(0, promptCount);

/**
 * Where to write the evidence, if anywhere.
 *
 * Strongly preferred over a shell redirection. `>` means the JSON only exists
 * once the process has printed and exited cleanly, and it means the shell
 * chooses the encoding -- Windows PowerShell 5.1 writes UTF-16LE, which no
 * JSON reader accepts. This writes UTF-8 from inside the process, as each
 * sample lands.
 */
const outPath = value("out");

/** Stamped once, so a file rewritten per sample keeps naming the same run. */
const startedRunAt = new Date().toISOString();

const apiKey =
  process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
  process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.error(
    "GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY) is not set."
  );
  process.exit(1);
}

const bodies = prompts.map((text) =>
  buildGoogleImageRequest({
    apiModelId: model.apiModelId,
    prompt: text,
    size: "1024x1024",
    maxOutputTokens: limit,
    thinkingLevel: thinkingLevel ?? model.thinkingLevel ?? null,
    // Through the shared helper, so this measures the request the adapter
    // would actually make rather than one that drifted away from it.
    deliveryMimeType: imageDeliveryMimeType(model),
  })
);
if (bodies.some((entry) => !entry)) {
  console.error("The request builder refused these parameters.");
  process.exit(1);
}

// The ceiling on this run, not on the budget: the script cannot see prices and
// does not enforce the §15 money limit. It bounds calls, and the human bounds
// spend by choosing the arguments. Said plainly here because "the tool stopped
// me before" is the wrong thing to rely on when the tool only counts requests.
const plannedCalls = prompts.length * repeats;

if (!flag("i-accept-the-cost")) {
  console.error(
    [
      `Would send up to ${plannedCalls} paid image generation(s) to ${model.id}`,
      `(${prompts.length} prompt(s) x ${repeats} repeat(s)) at`,
      `max_output_tokens=${limit}. Nothing was sent.`,
      "",
      "This script counts requests, not money. The §15 budget is enforced by",
      "whoever chooses --prompts, --repeats and the model.",
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
const sha256Prefix = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);
const promptHashes = prompts.map((text) => sha256Prefix(text));

/**
 * The report, from whatever has been measured so far.
 *
 * A function rather than a value built at the end, because the end is not
 * guaranteed. Every sample in here was paid for, and a process that dies after
 * the last request but before printing loses them all -- which is exactly what
 * happened on Windows, where Node aborted in libuv during teardown
 * (`uv_async_send` on a closing handle) after the work was done.
 *
 * `runComplete` is the fail-closed part. An interrupted run states no verdict
 * at all: a file left behind by a crash must not read like a conclusion, and
 * `consistent_with_limit_bounding_billable_output` computed over half the planned
 * samples would read exactly like one.
 */
function buildReport(runComplete) {
  // Evidence is usage, not imagery: a sample that reported what it billed
  // counts whether or not it also delivered a finished image.
  const measured = samples.filter((sample) => sample.measured);
  const exceeded = measured.filter((sample) => !sample.withinLimit);
  // "Bit" = a sample that got close enough to the ceiling that staying under
  // it is evidence of a limit rather than of modest usage. 90% is a judgement
  // call and is stated so the reader can disagree with it. A response that
  // stopped without finishing its image is the same evidence arriving the
  // other way.
  const bit = measured.filter(
    (sample) =>
      sample.billableOutputTokens >= limit * 0.9 ||
      sample.outcome === "measured_without_image"
  );
  const promptsMeasured = new Set(measured.map((sample) => sample.promptIndex));

  // The verdict names say "billable output", not "thinking", and the 2026-08-14
  // run is why. `max_output_tokens` did track thinking on its own at 256 and
  // 512 -- thinking stopped at limit minus three on every sample -- while a
  // request at 2,048 reported 1,602 output plus 931 thinking as billable usage
  // and returned a finished image. A verdict called
  // `limit_does_not_bound_thinking` would have been reported on a run where
  // thinking was, as far as anything here can tell, bounded. What is refuted is
  // the bound on the quantity we pay for, which is the sum, and that is what
  // `googleBillableOutputTokens` has always computed.
  const verdict = (() => {
    if (!runComplete) return "run_incomplete";
    if (measured.length === 0) return "inconclusive_no_samples";
    if (exceeded.length > 0) return "limit_does_not_bound_billable_output";
    if (bit.length === 0) return "inconclusive_limit_never_bound";
    // Policy §12 asks for several complex prompts. One prompt's samples can
    // support the other conclusions -- a counterexample is a counterexample --
    // but they cannot support the affirmative one on their own.
    if (promptsMeasured.size < 2) return "consistent_but_single_prompt";
    return "consistent_with_limit_bounding_billable_output";
  })();

  return {
    measuredAt: startedRunAt,
    runComplete,
    modelId: model.id,
    apiModelId: model.apiModelId,
    cardOutputLimit: model.maxOutputTokens ?? null,
    requestedMaxOutputTokens: limit,
    thinkingLevel: thinkingLevel ?? model.thinkingLevel ?? null,
    promptSha256Prefixes: promptHashes,
    promptSource: customPrompt ? "custom" : "built_in",
    // The bodies as sent, one per prompt, with the prompt itself digested
    // (policy §10). Kept rather than reconstructed: a report that re-derived
    // its own request from its own fields would be evidence of nothing.
    requestBodies: bodies.map((body) =>
      redactGoogleImageRequestBody(body, sha256Prefix)
    ),
    repeats,
    plannedCalls,
    sentCalls: samples.length,
    stoppedEarly: stopReason,
    samples,
    verdict,
  };
}

/**
 * Writes the evidence file, if one was asked for.
 *
 * Called after every sample rather than once at the end. Rewriting a small
 * file a dozen times costs nothing; losing a paid image generation to a crash
 * costs an image generation, and the sample most likely to be lost is the last
 * one -- which in this measurement is the most informative, because the run
 * stops on the first counterexample.
 *
 * The redaction pass is the same one the printed output gets. A file is worse
 * than a paste for this: it sits on disk until someone attaches it somewhere.
 */
function writeEvidence(report) {
  if (!outPath) return;
  writeFileSync(outPath, `${redact(JSON.stringify(report, null, 2))}\n`, "utf8");
}

const samples = [];
// Set once a further paid call would buy nothing: either the question is
// already answered (a counterexample settles it -- one sample over the limit
// means the limit does not bound thinking, and a second one cannot make that
// more true) or the responses stopped being readable at all, in which case
// every number after it is suspect anyway.
let stopReason = null;

// Written before the first request so an unwritable path fails here rather
// than after the money is spent. A run that cannot record its evidence should
// not buy any.
try {
  writeEvidence(buildReport(false));
} catch (error) {
  console.error(
    [
      `--out cannot be written: ${outPath}`,
      redact(error instanceof Error ? error.message : String(error)),
      "",
      "Checked before the first request, because a run that cannot record its",
      "evidence should not buy any. Nothing was sent.",
    ].join("\n")
  );
  process.exit(1);
}

outer: for (let round = 0; round < repeats; round += 1) {
  for (let promptIndex = 0; promptIndex < prompts.length; promptIndex += 1) {
    const index = samples.length;
    const startedAt = new Date().toISOString();
    let response;
    try {
      response = await fetch(GOOGLE_INTERACTIONS_URL, {
        method: "POST",
        headers: {
          [GOOGLE_API_KEY_HEADER]: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodies[promptIndex]),
        signal: AbortSignal.timeout(150_000),
      });
    } catch (error) {
      samples.push({
        index,
        promptIndex,
        startedAt,
        outcome: "request_failed",
        detail: redact(error instanceof Error ? error.message : String(error)),
      });
      stopReason = "request_failed";
      writeEvidence(buildReport(false));
      break outer;
    }

    const text = await response.text();
    if (!response.ok) {
      samples.push({
        index,
        promptIndex,
        startedAt,
        outcome: "http_error",
        status: response.status,
        detail: redact(text).slice(0, 300),
      });
      stopReason = "http_error";
      writeEvidence(buildReport(false));
      break outer;
    }

    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      samples.push({ index, promptIndex, startedAt, outcome: "unparseable_body" });
      stopReason = "unparseable_body";
      writeEvidence(buildReport(false));
      break outer;
    }

    // Two readings of the same response, asked separately. The strict parser
    // answers "is this a priceable image?"; the interaction reader answers
    // "what was billed and why did it stop?". They used to be one call, and a
    // response that ran out of room before finishing an image -- the most
    // informative sample this measurement can buy -- failed the first question
    // and so had its answer to the second thrown away with it.
    const parsed = parseGoogleImageResponse(payload);
    const interaction = readGoogleImageInteraction(payload);

    if (!interaction) {
      samples.push({
        index,
        promptIndex,
        startedAt,
        outcome: "unreadable_payload",
        // Enough to see the shape, never enough to reconstitute an image.
        topLevelKeys: Object.keys(payload ?? {}),
      });
      stopReason = "unreadable_payload";
      writeEvidence(buildReport(false));
      break outer;
    }

    const billable = googleBillableOutputTokens(interaction.usage);
    // Usage counters are the whole measurement. A response that reports none
    // is not a low sample, it is no sample -- and continuing to pay for more
    // of them is how a run spends its budget on nothing.
    const measured =
      interaction.usage.outputTokens > 0 || interaction.usage.thinkingTokens > 0;

    samples.push({
      index,
      promptIndex,
      startedAt,
      outcome: measured
        ? parsed
          ? "ok"
          : "measured_without_image"
        : "no_usage_reported",
      measured,
      responseId: payload?.id ?? payload?.name ?? null,
      inputTokens: interaction.usage.inputTokens,
      outputTokens: interaction.usage.outputTokens,
      thinkingTokens: interaction.usage.thinkingTokens,
      billableOutputTokens: billable,
      withinLimit: billable <= limit,
      // Printed only so the arithmetic can be checked by hand. It includes the
      // input, so it is never the number compared with the limit.
      reportedTotalTokens: payload?.usage?.total_tokens ?? null,
      // A response that stopped because it ran out of room is the sample that
      // actually demonstrates enforcement.
      finishReason: interaction.status,
      modelOutputImageCount: interaction.modelOutputImageCount,
      stepTypes: interaction.stepTypes,
      mimeType: parsed?.mimeType ?? null,
      // Policy §12 step 8 wants the raw response kept, and it is the only
      // field here a later reader can check the rest against. The image bytes
      // are the one part that cannot be read as text, so they arrive as a
      // digest and a length; everything the verdict rests on is verbatim.
      response: redactGoogleImageResponseBody(payload, sha256Prefix),
    });

    if (!measured) {
      stopReason = "no_usage_reported";
      writeEvidence(buildReport(false));
      break outer;
    }
    if (billable > limit) {
      stopReason = "counterexample_found";
      writeEvidence(buildReport(false));
      break outer;
    }
    writeEvidence(buildReport(false));
  }
}

const report = buildReport(true);
const verdict = report.verdict;
writeEvidence(report);

if (flag("json")) {
  // Redacted as one string rather than field by field. Individual `detail`
  // fields already go through `redact`, but this is the output a person pastes
  // into a ticket, and a key reaching it through a field nobody thought about
  // is exactly the failure that one pass over the finished text prevents.
  console.log(redact(JSON.stringify(report, null, 2)));
} else {
  console.log(`Model:      ${model.id}`);
  console.log(`Limit sent: ${limit} (card limit ${model.maxOutputTokens})`);
  console.log(
    `Prompts:    ${promptHashes
      .map((hash) => `sha256:${hash}`)
      .join(", ")} (text withheld -- policy §10)`
  );
  console.log(`Calls:      ${samples.length} sent of ${plannedCalls} planned`);
  console.log("");
  for (const sample of samples) {
    const label = `  #${sample.index} [p${sample.promptIndex}]`;
    if (!sample.measured) {
      console.log(
        `${label}  ${sample.outcome}${sample.status ? ` (${sample.status})` : ""}`
      );
      continue;
    }
    console.log(
      `${label}  output ${sample.outputTokens} + thinking ${sample.thinkingTokens}` +
        ` = ${sample.billableOutputTokens} vs limit ${limit}` +
        `  ${sample.withinLimit ? "within" : "OVER"}` +
        (sample.outcome === "measured_without_image"
          ? `  [no image; stopped: ${sample.finishReason ?? "unstated"}]`
          : "")
    );
  }
  console.log("");
  if (stopReason) {
    console.log(
      stopReason === "counterexample_found"
        ? "Stopped after the first sample over the limit: it settles the question,\n" +
            "and further paid calls would buy nothing."
        : `Stopped after ${stopReason}: the remaining calls were not sent.`
    );
    console.log("");
  }
  console.log(`Verdict: ${verdict}`);
  if (verdict === "inconclusive_no_samples") {
    console.log(
      "  No response reported usage counters, so nothing was measured. Resolve" +
        "\n  that before spending more of the budget."
    );
  }
  if (verdict === "inconclusive_limit_never_bound") {
    console.log(
      "  Every sample finished well under the ceiling. That shows the model is" +
        "\n  economical, not that the ceiling is enforced. Re-run with a lower" +
        "\n  --limit until some sample approaches it."
    );
  }
  if (verdict === "consistent_but_single_prompt") {
    console.log(
      "  Samples from one prompt only. How much a model thinks depends on what" +
        "\n  it was asked, so repeating one prompt is one prompt's evidence. Re-run" +
        "\n  with --prompts=2 (policy §12)."
    );
  }
  if (verdict === "limit_does_not_bound_billable_output") {
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

process.exit(verdict === "limit_does_not_bound_billable_output" ? 1 : 0);
