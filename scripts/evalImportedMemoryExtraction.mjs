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
 *   ... --limit=10                                       compatibility probe, not a run
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
// The successor set, not the frozen schema-1 one.
//
// This harness read `mem-eval-seed-11` until 2026-08-26, and would have
// scored the wrong dataset with the wrong scorer. It never could: the gate
// refused it with `legacy_dataset_schema` before any provider was reached,
// which is what fail-closed is for. But a funded pair that cannot run is a
// trap of its own, so the harness moves rather than the gate.
import {
    MEMORY_EVAL_SUCCESSOR_CASES as MEMORY_EVAL_CASES,
    MEMORY_EVAL_SUCCESSOR_DATASET_FROZEN as MEMORY_EVAL_DATASET_FROZEN,
    MEMORY_EVAL_SUCCESSOR_DATASET_PURPOSE as MEMORY_EVAL_DATASET_PURPOSE,
    MEMORY_EVAL_SUCCESSOR_DATASET_VERSION as MEMORY_EVAL_DATASET_VERSION,
} from "../lib/memoryEvalSuccessorFixtures.ts";
// The artifact envelope version and the second digest. The harness stays
// pinned to the approved current target -- there is no need to make an
// arbitrary past dataset billable -- but what it writes has to say which
// version and which labelling it ran on, or a later reader has to guess.
import { MEMORY_EVAL_ARTIFACT_SCHEMA } from "../lib/memoryEvalDatasetRegistry.ts";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    scoringContractDigest as scoringContractDigestOf,
} from "../lib/memoryEvalScoringContractDigest.ts";
import {
    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM,
    datasetFingerprintInput,
    decideEvalRunMode,
    findDuplicateCases,
    summarizeFailures,
} from "../lib/memoryExtractionEvalCore.ts";
import {
    judgeEvalV2 as judgeEval,
    scoreCaseV2 as scoreCase,
} from "../lib/memoryEvalScoringV2.ts";
import { MEMORY_EVAL_DATASET_SCHEMA_VERSION } from "../lib/memoryEvalDatasetSchema.ts";
import { createEvalLiveAdapter } from "../lib/memoryEvalLiveAdapter.ts";

const argValue = (name, fallback) => {
    const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return match ? match.slice(name.length + 3) : fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const modelId = argValue("model", "gpt-5-6-luna");
const jsonPath = argValue("json", "");
const live = hasFlag("live");
/**
 * A compatibility probe: run the first N cases and stop.
 *
 * Point of it is to learn whether the wiring works before paying to learn it
 * 1,150 times -- v1 spent three dispatches discovering, one failure at a
 * time, that the request was wrong. A probe is never a run: the artifact
 * records `probeLimit` and `decisionGrade` is false whatever the numbers say,
 * because a verdict from a slice of the sample is not a verdict.
 */
const rawProbeLimit = argValue("limit", "");
const probeLimit = rawProbeLimit === "" ? null : Number(rawProbeLimit);
if (probeLimit !== null && !(Number.isInteger(probeLimit) && probeLimit > 0)) {
    console.error(`--limit must be a positive integer (got "${rawProbeLimit}").`);
    process.exit(1);
}

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
const scoringContractDigest = scoringContractDigestOf(MEMORY_EVAL_CASES);

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
    commitKnown: commitSha !== "unknown",
    // The frozen fixtures are schema 1. Stated rather than assumed, so that
    // the successor dataset switching this to 2 is a visible edit here.
    datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
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
    pair_not_runnable:
        `${modelId}::${MEMORY_EXTRACTION_PROMPT_VERSION} is \`${registerEntry?.status}\` in the ` +
        "register (§12.1).\n\n" +
        "A revoked entry keeps its approved budget -- the approval was real and\n" +
        "was really spent against -- so the budget is not permission to run it\n" +
        "again. Register the pair you mean to evaluate, or reopen this one\n" +
        "deliberately as its own reviewed change.",
    unknown_commit:
        "This run cannot name the commit it is running (§12.2).\n\n" +
        "`git rev-parse HEAD` produced nothing, which means this is not a git\n" +
        "checkout -- a deployed container, an extracted tarball, a copied\n" +
        "directory. A decision-grade verdict is cited against a commit, and an\n" +
        "artifact that cannot name one is not evidence however good its numbers\n" +
        "are. Worse, `workingTreeDirty` comes out `false` there, so the run\n" +
        "would look clean.\n\n" +
        "Run it from a checkout of the commit under evaluation.",
    dataset_not_frozen:
        `Dataset ${MEMORY_EVAL_DATASET_VERSION} (${MEMORY_EVAL_DATASET_PURPOSE}) is not frozen (§12.2).\n\n` +
        "A decision-grade number computed against a sample that is still being\n" +
        "edited cannot be cited. Freeze the dataset — every cell at or above the\n" +
        "floor, authoring and independent review complete — then set\n" +
        "MEMORY_EVAL_DATASET_FROZEN and bump MEMORY_EVAL_DATASET_VERSION.",
    legacy_dataset_schema:
        `Dataset ${MEMORY_EVAL_DATASET_VERSION} is schema ${MEMORY_EVAL_DATASET_SCHEMA_VERSION}, ` +
        "and a live run requires schema 2 (§12.2, amended 2026-08-25).\n\n" +
        "It carries neither `expectedDisposition` nor `goldCompleteness`, so\n" +
        "bulk eligibility recall and the sensitive-review bulk-safe\n" +
        "misclassification count cannot be computed against it. A run would\n" +
        "still print numbers, and that is the danger: they would be the old\n" +
        "contract's numbers under the new contract's names.\n\n" +
        "Reproducing the mem-extract-v2 diagnostics is a separate path --\n" +
        "lib/memoryEvalLegacyDataset.ts, which is not a live run and cannot\n" +
        "support a verdict, a freeze or a pair approval.",
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
/**
 * The smoke answer: the gold, returned as if a model had produced it.
 *
 * `sensitivity` follows the case's own `expectedDisposition`. Answering
 * `standard` for everything — which this did until 2026-08-26 — makes the
 * smoke run report a sensitive-review misclassification for every health
 * case and a critical adoption for every mixed-critical one. Those numbers
 * say nothing about the pipeline, and a smoke run that always shows failures
 * trains its reader to ignore the counters that matter most.
 *
 * Evidence cites the first user message: the label map decides the role, so a
 * smoke answer cannot smuggle assistant-only evidence past the validator.
 */
const smokeAdapter = (testCase) => async () => ({
    output: {
        candidates: testCase.expected.map((expected) => ({
            kind: expected.kind,
            statement: `The user's record: ${expected.mustInclude.join(" ")}.`,
            confidence: 0.9,
            sensitivity:
                expected.expectedDisposition === "sensitive_review"
                    ? "sensitive"
                    : "standard",
            expiresAt: null,
            evidence: ["m1"],
        })),
    },
});

let accruedCostUsd = 0;
/**
 * Calls whose price could not be resolved.
 *
 * It matters because `accruedCostUsd` is what the spend ceiling reads. Every
 * unpriced call makes that figure a lower bound, and a ceiling compared
 * against a lower bound is a ceiling that binds late or not at all -- the one
 * direction that costs money. So the number is carried into the summary and
 * the artifact rather than swallowed: a run whose ceiling never had a real
 * figure behind it must not be presented as one that did.
 */
let pricingFailures = 0;
let costStopped = false;
let consecutiveFailures = 0;
let abortedOnFailures = false;

/** Consecutive scoreable-answer failures after which the run stops. */
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * The live adapter is the product's adapter.
 *
 * The delegation lives in `lib/memoryEvalLiveAdapter.ts` rather than here,
 * because it now has two callers: this harness and the development probe.
 * "Both build the same adapter" is a claim nobody checks until a run fails,
 * and three runs already died on exactly that kind of difference.
 */
const liveAdapter = createEvalLiveAdapter({
    modelId,
    onCostUsd: (usd) => {
        accruedCostUsd += usd;
    },
    onPricingFailure: () => {
        pricingFailures += 1;
    },
});

/* -------------------------------------------------------------------- run -- */

const outcomes = [];
const records = [];

for (const testCase of MEMORY_EVAL_CASES) {
    if (probeLimit !== null && outcomes.length >= probeLimit) break;
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
// Two axes, printed apart, because the 2026-08-25 amendment split them for a
// reason: one number answering both questions is what made mem-extract-v2's
// precision of 0.12 unreadable.
const ratio = (numerator, denominator, wilsonLower) =>
    `${numerator}/${denominator} = ${
        denominator === 0 ? "n/a" : (numerator / denominator).toFixed(3)
    }   Wilson lower ${wilsonLower.toFixed(4)}`;

line("cases", verdict.aggregate.cases);
line("failures", verdict.aggregate.failures);
line(
    "precision",
    ratio(
        verdict.aggregate.precisionNumerator,
        verdict.aggregate.precisionDenominator,
        verdict.aggregate.precisionWilsonLower
    )
);
line(
    "recall",
    ratio(
        verdict.aggregate.recallNumerator,
        verdict.aggregate.recallDenominator,
        verdict.aggregate.recallWilsonLower
    )
);

console.log("\nBulk-activation safety");
line(
    "bulk eligibility recall",
    ratio(
        verdict.aggregate.bulkEligibilityNumerator,
        verdict.aggregate.bulkEligibilityDenominator,
        verdict.aggregate.bulkEligibilityWilsonLower
    )
);
// Zero-tolerance, and never averaged across arms.
line("critical bulk-safe adoptions", verdict.aggregate.criticalBulkSafeAdoptions);
line(
    "sensitive-review misclassifications",
    verdict.aggregate.sensitiveExpectedBulkSafeViolations
);

for (const [language, arm] of Object.entries(verdict.byLanguage)) {
    console.log(`\nArm: ${language}`);
    line("cases", arm.cases);
    line("precision Wilson lower", arm.precisionWilsonLower.toFixed(4));
    line("recall Wilson lower", arm.recallWilsonLower.toFixed(4));
    line(
        "bulk eligibility Wilson lower",
        arm.bulkEligibilityWilsonLower.toFixed(4)
    );
    line("critical bulk-safe adoptions", arm.criticalBulkSafeAdoptions);
    line(
        "sensitive-review misclassifications",
        arm.sensitiveExpectedBulkSafeViolations
    );
}

console.log("\nSample adequacy (§12.2)");
for (const [cell, count] of Object.entries(verdict.adequacy.counts)) {
    // The floor is per category now, so the cell has to carry its own number.
    const minimum =
        MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[cell.split(":")[0]];
    line(cell, `${count}${count < minimum ? `  (needs ${minimum})` : ""}`);
}

// Why cases failed, not just how many. Without this the run says the pair is
// broken and leaves the reason in the artifact, so the first thing anybody
// does after a failed run is download a file to read one repeated sentence.
const failureReasons = summarizeFailures(records);
if (failureReasons.length > 0) {
    const scored = records.filter((record) => record.failure).length;
    console.log(`\nWhy ${scored} case(s) had no scoreable answer`);
    for (const { reason, count } of failureReasons.slice(0, 5)) {
        const text = reason.length > 300 ? `${reason.slice(0, 300)}…` : reason;
        console.log(`  ${String(count).padStart(4)}x  ${text}`);
    }
    if (failureReasons.length > 5) {
        console.log(`  … and ${failureReasons.length - 5} other reason(s).`);
    }
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
if (probeLimit !== null) {
    // What a probe is actually for. Without this it answers "did the answers
    // parse", and the first one did -- while nine adoptions matched three
    // gold labels and the summary could not say whether the other six were
    // wrong, extra-but-correct, or right with a different `kind`. Those need
    // different responses and the counts collapse them into one number.
    //
    // Bounded by --limit, so it cannot become a wall of text.
    const byId = new Map(MEMORY_EVAL_CASES.map((entry) => [entry.id, entry]));
    console.log("\nWhat the model returned, case by case");
    for (const record of records) {
        const testCase = byId.get(record.caseId);
        const expected = testCase?.expected ?? [];
        console.log(`\n  ${record.caseId}  (${record.category}:${record.language})`);
        if (record.failure) {
            console.log(`    failed: ${record.failure}`);
            continue;
        }
        console.log(
            expected.length === 0
                ? "    expected: nothing (extracting anything is a false positive)"
                : `    expected: ${expected
                      .map((entry) => `${entry.kind} + [${entry.mustInclude.join(", ")}]`)
                      .join("; ")}`
        );
        if (record.candidates.length === 0) {
            console.log("    returned: (nothing)");
            continue;
        }
        for (const candidate of record.candidates) {
            // Why a candidate did not count, named rather than implied: a
            // right statement filed under the wrong kind never matches, and
            // that reads identically to a wrong statement in the totals.
            const kindMatches = expected.some((entry) => entry.kind === candidate.kind);
            const tokensMatch = expected.some((entry) =>
                entry.mustInclude.every((token) =>
                    candidate.statement.toLowerCase().includes(token.toLowerCase())
                )
            );
            const verdict = !candidate.bulkSafe
                ? "not adopted"
                : kindMatches && tokensMatch
                  ? "MATCH"
                  : tokensMatch
                    ? `tokens match, kind differs (expected ${expected.map((e) => e.kind).join("/")})`
                    : kindMatches
                      ? "kind matches, tokens do not"
                      : "neither";
            console.log(
                `    [${verdict}] ${candidate.kind} · bulk-safe ${candidate.bulkSafe} — ${candidate.statement}`
            );
        }
    }
    console.log(
        "\nA candidate that reads correctly but is filed under another kind counts as\n" +
            "a false positive, because §12.3 is scored on the gold label. Whether that is\n" +
            "the model, the label or the taxonomy is a question for a person -- the counts\n" +
            "above cannot tell them apart, which is why the statements are printed."
    );
    console.log(
        `\nPROBE — ran the first ${outcomes.length} case(s) of ${MEMORY_EVAL_CASES.length} and stopped at --limit.\n` +
            "This is a compatibility check, not a run: it says whether the request, the\n" +
            "schema, the parser and the validator agree end to end on real answers. Its\n" +
            "numbers are a slice of the sample and are not a verdict at any quality."
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
    if (pricingFailures > 0) {
        line("calls whose price did not resolve", pricingFailures);
        console.log(
            `\nCEILING NOT RELIABLE — ${pricingFailures} of ${outcomes.length} calls could not be\n` +
                "priced, so the accrued figure above is a lower bound and the ceiling was\n" +
                "compared against it. Treat the spend as unbounded for this run and settle it\n" +
                "from the provider's own invoice before quoting a cost anywhere."
        );
    }
}

const artifact = {
    manifest: {
        // The envelope version a reader uses to tell a current artifact from
        // one written before `scoringContractDigest` existed. An artifact at
        // this schema that lost either digest is refused rather than read as
        // historical: lib/memoryEvalDatasetRegistry.ts.
        artifactSchema: MEMORY_EVAL_ARTIFACT_SCHEMA,
        modelId,
        promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
        datasetVersion: MEMORY_EVAL_DATASET_VERSION,
        datasetDigest,
        // The second digest, and not a duplicate of the first: the dataset
        // digest does not cover expectedDisposition, goldCompleteness,
        // mustIncludeAny or criticalGoldMode, so two runs can agree on it and
        // still have been scored on different labels.
        scoringContractDigest,
        scoringContractVersion: MEMORY_EVAL_SCORING_CONTRACT_VERSION,
        mode: runMode.mode,
        commitSha,
        workingTreeDirty,
        generatedAt: new Date().toISOString(),
        caseCount: outcomes.length,
        plannedCaseCount: MEMORY_EVAL_CASES.length,
        truncatedByCostCeiling: costStopped,
        // Non-null means this was a probe, and the fields below say so too.
        probeLimit,
        maxCostUsd,
        accruedCostUsd: runMode.mode === "live" ? accruedCostUsd : 0,
        // How many calls the accrued figure is missing. Zero means the ceiling
        // had a real number behind it for every call; anything else means the
        // figure is a lower bound, and an artifact that did not say so would
        // let an unbounded run be read as a bounded one.
        pricingFailures: runMode.mode === "live" ? pricingFailures : 0,
        spendCeilingReliable: runMode.mode !== "live" || pricingFailures === 0,
        // Decision-grade needs all three: a live run, a sample at the §12.2
        // floor, and a frozen dataset. Any one missing and the artifact says so.
        decisionGrade:
            verdict.adequacy.decisionGrade &&
            runMode.mode === "live" &&
            MEMORY_EVAL_DATASET_FROZEN &&
            probeLimit === null,
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
