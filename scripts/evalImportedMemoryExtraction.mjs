/**
 * Memory-extraction eval harness (Release B, §12.2–§12.4).
 *
 * docs/policy/external-conversation-import-and-memory.md §12.
 *
 * Usage:
 *   npm run eval:memory-extraction                       smoke run, no provider call
 *   npm run eval:memory-extraction -- --live             real provider run
 *   ... --model=gpt-5-6-luna                             pair under evaluation
 *   ... --json=artifacts/mem-eval.json                   preserve the artifact
 *   ... --max-cost-usd=5                                 hard stop on spend
 *
 * What this does NOT do, on purpose:
 *
 *   * it does not approve anything. §12.4 splits code completion from
 *     operational activation: this file computes a verdict, and moving a
 *     register entry to `approved` stays a human act with a signature;
 *   * it does not run live without a human-approved eval budget (§12.5). A
 *     candidate pair with `evalBudget: null` is smoke-mode only, and the
 *     refusal below is the enforcement of that, not a suggestion;
 *   * it does not quietly drop failures. A provider error or an unparseable
 *     answer is a scored case with a reason, because a run that hides them
 *     reports a cleaner number than it earned (§12.2);
 *   * it does not report a seed-sized sample as decision-grade. Below the
 *     §12.2 floor the verdict is withheld and the run is labelled
 *     UNDERPOWERED.
 *
 * The fixtures are synthetic and live in lib/memoryExtractionEvalFixtures.ts.
 * No real user data enters this pipeline.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { analyzeExtractionChunk } from "../lib/memoryExtractionPipeline.ts";
import { MEMORY_EXTRACTION_PROMPT_VERSION } from "../lib/memoryExtractionPrompt.ts";
import {
    MEMORY_EXTRACTION_EVAL_REGISTER,
} from "../lib/memoryExtractionEvalRegister.ts";
import {
    MEMORY_EVAL_CASES,
    MEMORY_EVAL_DATASET_FROZEN,
    MEMORY_EVAL_DATASET_PURPOSE,
    MEMORY_EVAL_DATASET_VERSION,
} from "../lib/memoryExtractionEvalFixtures.ts";
import {
    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM,
    datasetFingerprintInput,
    decideEvalRunMode,
    findDuplicateCases,
    judgeEval,
    scoreCase,
} from "../lib/memoryExtractionEvalCore.ts";

const argValue = (name, fallback) => {
    const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return match ? match.slice(name.length + 3) : fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const modelId = argValue("model", "gpt-5-6-luna");
const jsonPath = argValue("json", "");
const live = hasFlag("live");
const rawMaxCost = argValue("max-cost-usd", "");
const maxCostUsd = rawMaxCost === "" ? null : Number(rawMaxCost);
if (maxCostUsd !== null && !(Number.isFinite(maxCostUsd) && maxCostUsd > 0)) {
    console.error(`--max-cost-usd must be a positive number (got "${rawMaxCost}").`);
    process.exit(1);
}

const gitOutput = (args) => {
    try {
        return execFileSync("git", args, { encoding: "utf8" }).trim();
    } catch {
        return "";
    }
};
const commitSha = gitOutput(["rev-parse", "HEAD"]) || "unknown";
const workingTreeDirty = gitOutput(["status", "--porcelain"]).length > 0;

/** Provider messages may echo a key; nothing key-shaped reaches the artifact. */
const redactSecrets = (message) => {
    const key = process.env.OPENAI_API_KEY?.trim();
    return (key ? String(message).split(key).join("[REDACTED_API_KEY]") : String(message))
        .replace(/\b(sk|rk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED_API_KEY]")
        .replace(/(authorization|api[-_]?key)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]");
};

/** Ties an archived verdict to the exact sample it was computed from (§12.2). */
const datasetDigest = createHash("sha256")
    .update(datasetFingerprintInput(MEMORY_EVAL_CASES), "utf8")
    .digest("hex");

const contentDigest = (content) =>
    createHash("sha256")
        .update(content.normalize("NFC").replace(/\r\n?/g, "\n"), "utf8")
        .digest("hex");

/* ------------------------------------------------------------------ gates -- */

const registerEntry = MEMORY_EXTRACTION_EVAL_REGISTER.find(
    (entry) =>
        entry.extractionModelId === modelId &&
        entry.promptVersion === MEMORY_EXTRACTION_PROMPT_VERSION
);
if (!registerEntry) {
    console.error(
        `No register entry for ${modelId}::${MEMORY_EXTRACTION_PROMPT_VERSION}.\n` +
            "Add a candidate entry to lib/memoryExtractionEvalRegister.ts first (§12.1)."
    );
    process.exit(1);
}

// The single decision about whether a provider may be reached at all. It is
// taken here, before anything that could call one is imported: the live
// adapter's `import("ai")` is inside a function that only a `live` decision
// ever reaches (tests/memoryExtractionEvalBoundary.test.mjs proves that with
// the network blocked).
const runMode = decideEvalRunMode({
    live,
    registerEntry,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY?.trim()),
    datasetFrozen: MEMORY_EVAL_DATASET_FROZEN,
    requestedRunCapUsd: maxCostUsd,
});

const REFUSAL_MESSAGES = {
    unknown_pair: `No register entry for ${modelId}::${MEMORY_EXTRACTION_PROMPT_VERSION}.`,
    no_eval_budget:
        `${modelId}::${MEMORY_EXTRACTION_PROMPT_VERSION} has no approved eval budget (§12.5).\n\n` +
        "Smoke mode needs no budget:\n" +
        "  npm run eval:memory-extraction\n\n" +
        "A live run needs `evalBudget` filled in on this entry in\n" +
        "lib/memoryExtractionEvalRegister.ts (approvedBy, maxUsd, ticket, approvedAt),\n" +
        "merged as its own reviewed change. That record is the audit trail.",
    no_api_key: "OPENAI_API_KEY is required for --live.",
    dataset_not_frozen:
        `Dataset ${MEMORY_EVAL_DATASET_VERSION} (${MEMORY_EVAL_DATASET_PURPOSE}) is not frozen (§12.2).\n\n` +
        "A decision-grade number computed against a sample that is still being\n" +
        "edited cannot be cited. Freeze the dataset — every cell at or above the\n" +
        "floor, authoring and independent review complete — then set\n" +
        "MEMORY_EVAL_DATASET_FROZEN and bump MEMORY_EVAL_DATASET_VERSION.",
    run_cap_above_approved_ceiling:
        `--max-cost-usd=${maxCostUsd} is above the approved ceiling for this pair ` +
        `(US$${registerEntry?.evalBudget?.maxUsd}).\n` +
        "A per-run cap may narrow the approved budget, never widen it.",
};

if (runMode.mode === "refused") {
    console.error(`\n${REFUSAL_MESSAGES[runMode.reason]}\n`);
    process.exit(1);
}

const duplicates = findDuplicateCases(MEMORY_EVAL_CASES);
if (duplicates.length > 0) {
    // §12.2 forbids inflating the sample with copies or trivial variants.
    console.error(
        "\nThe fixture set contains duplicate cases, which §12.2 forbids:\n" +
            duplicates.map((line) => `  ${line}`).join("\n") +
            "\n"
    );
    process.exit(1);
}

/* ---------------------------------------------------------------- adapters -- */

/**
 * The smoke adapter. Deterministic, offline, and deliberately *not* a
 * simulation of model quality: it returns the answer a correct extractor
 * would give for the fixtures it recognises, so a smoke run exercises prompt
 * assembly, parsing, the validator and the scoring end to end without
 * claiming anything about the model. Its numbers are never a verdict — the
 * sample is below the §12.2 floor either way.
 */
const smokeAdapter = (testCase) => async () => {
    if (testCase.expected.length === 0) return { output: { candidates: [] } };
    // Cite the first user message: the label map decides the role, so a smoke
    // answer cannot smuggle assistant-only evidence past the validator.
    return {
        output: {
            candidates: testCase.expected.map((expected) => ({
                kind: expected.kind,
                statement: `The user's record: ${expected.mustInclude.join(" ")}.`,
                confidence: 0.9,
                sensitivity: "standard",
                expiresAt: null,
                evidence: ["m1"],
            })),
        },
    };
};

let accruedCostUsd = 0;
let costStopped = false;
let consecutiveFailures = 0;
let abortedOnFailures = false;

/** Consecutive scoreable-answer failures after which the run stops. */
const MAX_CONSECUTIVE_FAILURES = 5;

const liveAdapter = async ({ prompt }) => {
    const [{ generateText }, { getActiveAiModel }, { getModel }, { resolveModelPricing }] =
        await Promise.all([
            import("ai"),
            import("../lib/activeAiModel.ts"),
            import("../lib/models.ts"),
            import("../lib/modelPricing.ts"),
        ]);
    const model = getModel(modelId);
    const result = await generateText({
        model: getActiveAiModel(model),
        messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
        ],
        maxOutputTokens: 4_096,
    });
    const usage = result.usage ?? {};
    try {
        const pricing = resolveModelPricing(modelId, usage.inputTokens ?? 0);
        accruedCostUsd +=
            ((usage.inputTokens ?? 0) * pricing.inputUsdPerMillionTokens +
                (usage.outputTokens ?? 0) * pricing.outputUsdPerMillionTokens) /
            1_000_000;
    } catch {
        // Pricing is for the spend ceiling only; a resolution failure must not
        // abort a run that is otherwise fine.
    }
    return { text: result.text ?? "" };
};

/* -------------------------------------------------------------------- run -- */

const outcomes = [];
const records = [];

for (const testCase of MEMORY_EVAL_CASES) {
    // The ceiling is the approved budget narrowed by any --max-cost-usd, so a
    // runaway retry or an output-token anomaly stops here rather than being
    // discovered on the invoice.
    if (runMode.mode === "live" && accruedCostUsd >= runMode.ceilingUsd) {
        costStopped = true;
        break;
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // A pair that fails this many times running is broken, not unlucky.
        // Continuing would spend the rest of the budget proving it again.
        abortedOnFailures = true;
        break;
    }
    const conversations = testCase.conversations.map((conversation) => ({
        externalConversationId: conversation.externalConversationId,
        title: conversation.title,
        messages: conversation.messages.map((message) => ({
            externalMessageId: message.externalMessageId,
            role: message.role,
            content: message.content,
            contentDigest: contentDigest(message.content),
        })),
    }));

    let analysis = null;
    let failure = null;
    try {
        analysis = await analyzeExtractionChunk({
            conversations,
            adapter:
                runMode.mode === "live" ? liveAdapter : smokeAdapter(testCase),
        });
    } catch (error) {
        failure = redactSecrets(error?.message ?? "adapter threw");
    }

    if (analysis && analysis.decisions.length === 0 && analysis.problems.length > 0) {
        // A structurally unusable answer is a failure, not an empty result:
        // scoring it as "extracted nothing" would flatter a broken run in
        // categories 2-4, where extracting nothing is the pass condition.
        failure = `unparseable answer: ${analysis.problems
            .map((problem) => problem.reason ?? String(problem))
            .join(", ")}`;
    }

    const candidates = (analysis?.decisions ?? []).map((decision) => ({
        kind: decision.candidate.kind,
        statement: decision.candidate.statement,
        bulkSafe: decision.validation.bulkSafe,
        disposition: decision.validation.disposition,
    }));

    consecutiveFailures = failure ? consecutiveFailures + 1 : 0;
    const outcome = scoreCase(testCase, candidates, failure);
    outcomes.push(outcome);
    records.push({
        caseId: testCase.id,
        category: testCase.category,
        language: testCase.language,
        failure,
        // Kept for the §12.4 blind qualitative review. These are answers to
        // this repository's own synthetic fixtures — no user content.
        candidates,
        outcome,
    });
}

const verdict = judgeEval(outcomes);

/* ----------------------------------------------------------------- report -- */

const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

console.log(`\nMemory extraction eval — ${modelId}::${MEMORY_EXTRACTION_PROMPT_VERSION}`);
console.log(
    `  mode: ${runMode.mode === "live" ? "LIVE" : "SMOKE"}   commit: ${commitSha}\n` +
        `  dataset: ${MEMORY_EVAL_DATASET_VERSION} (${MEMORY_EVAL_DATASET_PURPOSE}, ` +
        `${MEMORY_EVAL_DATASET_FROZEN ? "frozen" : "not frozen"})  digest: ${datasetDigest.slice(0, 16)}…`
);

console.log("\nAggregate");
line("cases", verdict.aggregate.cases);
line("failures", verdict.aggregate.failures);
line("adopted (bulk-safe)", verdict.aggregate.adopted);
line("true positives", verdict.aggregate.truePositives);
line("false positives", verdict.aggregate.falsePositives);
line("precision Wilson lower", verdict.aggregate.precisionWilsonLower.toFixed(4));
line("recall Wilson lower", verdict.aggregate.recallWilsonLower.toFixed(4));
line("critical false acceptances", verdict.aggregate.criticalFalseAcceptances);

for (const [language, arm] of Object.entries(verdict.byLanguage)) {
    console.log(`\nArm: ${language}`);
    line("cases", arm.cases);
    line("precision Wilson lower", arm.precisionWilsonLower.toFixed(4));
    line("recall Wilson lower", arm.recallWilsonLower.toFixed(4));
    line("critical false acceptances", arm.criticalFalseAcceptances);
}

console.log("\nSample adequacy (§12.2)");
for (const [cell, count] of Object.entries(verdict.adequacy.counts)) {
    // The floor is per category now, so the cell has to carry its own number.
    const minimum =
        MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[cell.split(":")[0]];
    line(cell, `${count}${count < minimum ? `  (needs ${minimum})` : ""}`);
}

if (verdict.failures.length > 0) {
    console.log("\nNot a pass:");
    for (const failure of verdict.failures) console.log(`  - ${failure}`);
} else {
    console.log("\nEvery §12.3 rule passed on this sample.");
}

if (runMode.mode !== "live") {
    console.log(
        "\nSMOKE RUN — NOT an eval result. No provider was called; the answers were\n" +
            "produced by a deterministic stub, so these numbers say nothing about the\n" +
            "model. What a smoke run does establish is that the prompt, the parser, the\n" +
            "§8.4 validator and the scoring agree end to end."
    );
}
if (!verdict.adequacy.decisionGrade) {
    const floors = Object.entries(MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM)
        .map(([category, minimum]) => `${category} ${minimum}`)
        .join(", ");
    console.log(
        `\nUNDERPOWERED — a cell is below the §12.2 floor (${floors} per language arm),\n` +
            "so no verdict is available at any quality. The cells short of it are listed\n" +
            "above with the number each one needs. Authoring the remaining cases is a data\n" +
            "task: §12.2 forbids reaching the floor by copying or lightly varying the\n" +
            "existing ones, and the duplicate check refuses a dataset that tries."
    );
}
if (workingTreeDirty) {
    console.log(
        "\nWorking tree is dirty, so the commit above does not fully describe what ran."
    );
}
if (abortedOnFailures) {
    console.log(
        `\nABORTED — stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive cases failed to ` +
            `produce a scoreable answer, at ${outcomes.length}/${MEMORY_EVAL_CASES.length} cases.\n` +
            "A pair failing that consistently is broken, not unlucky; the rest of the budget\n" +
            "would only prove it again."
    );
}
if (costStopped) {
    console.log(
        `\nTRUNCATED — stopped at the --max-cost-usd=${maxCostUsd} ceiling after ` +
            `${outcomes.length}/${MEMORY_EVAL_CASES.length} cases. The missing cases were planned, not absent.`
    );
}
if (runMode.mode === "live") {
    line("\naccrued cost (USD, estimate)", accruedCostUsd.toFixed(4));
    if (registerEntry.evalBudget) {
        line("approved ceiling (USD)", registerEntry.evalBudget.maxUsd);
    }
}

const artifact = {
    manifest: {
        modelId,
        promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
        datasetVersion: MEMORY_EVAL_DATASET_VERSION,
        datasetDigest,
        mode: runMode.mode,
        commitSha,
        workingTreeDirty,
        generatedAt: new Date().toISOString(),
        caseCount: outcomes.length,
        plannedCaseCount: MEMORY_EVAL_CASES.length,
        truncatedByCostCeiling: costStopped,
        maxCostUsd,
        accruedCostUsd: runMode.mode === "live" ? accruedCostUsd : 0,
        // Decision-grade needs all three: a live run, a sample at the §12.2
        // floor, and a frozen dataset. Any one missing and the artifact says so.
        decisionGrade:
            verdict.adequacy.decisionGrade &&
            runMode.mode === "live" &&
            MEMORY_EVAL_DATASET_FROZEN,
        datasetFrozen: MEMORY_EVAL_DATASET_FROZEN,
        datasetPurpose: MEMORY_EVAL_DATASET_PURPOSE,
        abortedOnConsecutiveFailures: abortedOnFailures,
        runCeilingUsd: runMode.mode === "live" ? runMode.ceilingUsd : null,
    },
    verdict: {
        pass: verdict.pass,
        failures: verdict.failures,
        aggregate: verdict.aggregate,
        byLanguage: verdict.byLanguage,
        adequacy: verdict.adequacy,
    },
    records,
};

if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    console.log(`\nArtifact written to ${jsonPath}`);
} else {
    console.log(
        "\nNo --json path given, so nothing was preserved. A decision-grade run without\n" +
            "its raw records cannot be cited in the register (§12.1)."
    );
}

// Exit status reports the §12.3 judgement, so CI or a wrapper can gate on it.
// A smoke run always exits non-zero on the underpowered rule, which is correct:
// it is not a pass.
process.exit(verdict.pass ? 0 : 1);
