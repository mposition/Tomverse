/**
 * The development probe: does a number from this pipeline mean anything?
 *
 *   npm run probe:memory-extraction
 *   npm run probe:memory-extraction -- --live --model=gpt-5-6-luna --json=out.json
 *
 * `docs/ops/memory-extraction-eval-dataset.md` §5, and step 7 of
 * `.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md` §7.
 *
 * ## What this is, and what it is not
 *
 * The `mem-extract-v2` probes answered "did the answers parse". They did, and
 * the precision that came back was 0.12 and meant nothing, because four
 * contract defects were being measured at once. Schema 2, the split scorer and
 * `mem-extract-v3` were all written so a number would mean something. This
 * probe is where that gets checked — against a small set built so that every
 * metric has at least one case that moves it — before 1,150 paid calls rest
 * on it.
 *
 * It **cannot produce evidence**. The set is `development`, it is far below
 * the docs/policy/external-conversation-import-and-memory.md §12.2 floor,
 * and the artifact records `decisionGrade: false`, which
 * `scripts/check-memory-eval-run-admissibility.mjs` discards. `judgeEvalV2`
 * refuses `pass: true` against a sample this size whatever the numbers say.
 *
 * ## Sharing, deliberately
 *
 * The provider call comes from `lib/memoryEvalLiveAdapter.ts`, the same module
 * the decision-grade harness uses, which in turn delegates to the product's
 * `createExtractionProviderAdapter`. Three live runs once died on a harness
 * that built its own call; a second script rebuilding it would have been the
 * same defect with a different filename.
 *
 * The gate is `decideEvalRunMode` — the same one — with
 * `datasetPurpose: "development"`. That waives the freeze requirement and
 * nothing else: the pair must still be runnable and funded, the key must
 * exist, the commit must be nameable, and the run cap cannot exceed the
 * approval.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { analyzeExtractionChunk } from "../lib/memoryExtractionPipeline.ts";
import { MEMORY_EXTRACTION_PROMPT_VERSION } from "../lib/memoryExtractionPrompt.ts";
import { MEMORY_EXTRACTION_EVAL_REGISTER } from "../lib/memoryExtractionEvalRegister.ts";
import {
    MEMORY_EVAL_DEVELOPMENT_PROBE_CASES,
    MEMORY_EVAL_DEVELOPMENT_PROBE_PURPOSE,
    MEMORY_EVAL_DEVELOPMENT_PROBE_VERSION,
} from "../lib/memoryEvalDevelopmentProbeSet.ts";
import {
    MEMORY_EVAL_DATASET_SCHEMA_VERSION,
    validateSuccessorDataset,
} from "../lib/memoryEvalDatasetSchema.ts";
import {
    aggregateOutcomesV2,
    judgeEvalV2,
    scoreCaseV2,
} from "../lib/memoryEvalScoringV2.ts";
import { decideEvalRunMode } from "../lib/memoryExtractionEvalCore.ts";
import { createEvalLiveAdapter } from "../lib/memoryEvalLiveAdapter.ts";

const argValue = (name, fallback) => {
    const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return match ? match.slice(name.length + 3) : fallback;
};

const live = process.argv.includes("--live");
const modelId = argValue("model", "gpt-5-6-luna");
const jsonPath = argValue("json", "");
const rawMaxCost = argValue("max-cost-usd", "");
const maxCostUsd = rawMaxCost === "" ? null : Number(rawMaxCost);
if (maxCostUsd !== null && !(Number.isFinite(maxCostUsd) && maxCostUsd > 0)) {
    console.error("--max-cost-usd must be a positive number.");
    process.exit(1);
}

const commitSha = (() => {
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
        }).trim();
    } catch {
        return "unknown";
    }
})();
const workingTreeDirty = (() => {
    try {
        return (
            execFileSync("git", ["status", "--porcelain"], {
                encoding: "utf8",
            }).trim().length > 0
        );
    } catch {
        return false;
    }
})();

/* ------------------------------------------------------ the set itself -- */

// Validated before anything is spent. A probe against a malformed set would
// produce numbers whose shape nobody had checked, which is the failure this
// whole sequence exists to stop.
const validation = validateSuccessorDataset({
    cases: MEMORY_EVAL_DEVELOPMENT_PROBE_CASES,
    purpose: MEMORY_EVAL_DEVELOPMENT_PROBE_PURPOSE,
});
if (!validation.ok) {
    console.error("\nThe probe set does not validate:");
    for (const error of validation.errors) {
        console.error(`  ${error.code}  ${error.caseId ?? "-"}  ${error.detail}`);
    }
    process.exit(1);
}

/* -------------------------------------------------------------- the gate -- */

const registerEntry = MEMORY_EXTRACTION_EVAL_REGISTER.find(
    (entry) =>
        entry.extractionModelId === modelId &&
        entry.promptVersion === MEMORY_EXTRACTION_PROMPT_VERSION
);

const runMode = decideEvalRunMode({
    live,
    registerEntry,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY?.trim()),
    // A development set is expected to still be moving. That is the one gate
    // `datasetPurpose` waives, and the reason it is safe is that this run can
    // never be cited: see the header.
    datasetFrozen: false,
    datasetPurpose: MEMORY_EVAL_DEVELOPMENT_PROBE_PURPOSE,
    datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
    commitKnown: commitSha !== "unknown",
    requestedRunCapUsd: maxCostUsd,
});

const REFUSALS = {
    unknown_pair:
        `No register entry for ${modelId}::${MEMORY_EXTRACTION_PROMPT_VERSION}.\n` +
        "Add a candidate entry to lib/memoryExtractionEvalRegister.ts first.",
    pair_not_runnable:
        `${modelId}::${MEMORY_EXTRACTION_PROMPT_VERSION} is \`${registerEntry?.status}\` ` +
        "in the register. A closed pair is closed for a probe too.",
    no_eval_budget:
        `${modelId}::${MEMORY_EXTRACTION_PROMPT_VERSION} has no approved eval budget.\n\n` +
        "A probe is cheap, not free, and cheap is not an approval. Smoke mode\n" +
        "needs no budget and checks the same wiring:\n" +
        "  npm run probe:memory-extraction\n\n" +
        "A live probe needs `evalBudget` filled in on this entry, merged as its\n" +
        "own reviewed change. Note that a budget does not travel with a version\n" +
        "bump: mem-extract-v2's approval was for v2.",
    no_api_key: "OPENAI_API_KEY is required for --live.",
    unknown_commit:
        "This run cannot name the commit it is running.\n\n" +
        "A probe's whole output is a comparison against what the contract says\n" +
        "should happen, and a comparison nobody can tie to a commit cannot be\n" +
        "acted on. Run it from a checkout.",
    legacy_dataset_schema:
        "The probe set is schema 2 and the gate disagrees — which should be\n" +
        "impossible, and means the two constants have drifted.",
    dataset_not_frozen:
        "A development set is not frozen by design, so reaching this refusal\n" +
        "means `datasetPurpose` did not arrive at the gate.",
    run_cap_above_approved_ceiling:
        `--max-cost-usd=${maxCostUsd} is above the approved ceiling for this pair ` +
        `(US$${registerEntry?.evalBudget?.maxUsd}).\n` +
        "A per-run cap may narrow the approved budget, never widen it.",
};

if (runMode.mode === "refused") {
    console.error(`\n${REFUSALS[runMode.reason]}\n`);
    process.exit(1);
}

/* ------------------------------------------------------------- adapters -- */

let accruedCostUsd = 0;
let pricingFailures = 0;

const liveAdapter = createEvalLiveAdapter({
    modelId,
    onCostUsd: (usd) => {
        accruedCostUsd += usd;
    },
    onPricingFailure: () => {
        pricingFailures += 1;
    },
});

/**
 * The smoke stub answers each case exactly right, and marks health sensitive.
 *
 * A stub that answered `standard` for everything would make the smoke run
 * report a sensitive-review misclassification for every health case, which
 * says nothing about the pipeline and trains the reader to ignore the number.
 */
/**
 * The label of a message this case really presents, and a real span of it.
 *
 * `mem-extract-v6` requires each citation to carry a quote that occurs in the
 * message it names, checked against the server's own copy. A stub that quoted
 * a constant would be rejected by its own parser on every case, and a smoke
 * run reporting zero candidates everywhere looks like a run while measuring
 * nothing. The first user message is preferred for the same reason the
 * label-only version cited it: the label map decides the role, so a smoke
 * answer cannot smuggle assistant-only evidence past the validator.
 */
const smokeCitation = (testCase) => {
    let ordinal = 0;
    let firstMessage = null;
    for (const conversation of testCase.conversations) {
        for (const message of conversation.messages) {
            ordinal += 1;
            const citation = {
                messageLabel: `m${ordinal}`,
                quote: [...message.content.normalize("NFC")]
                    .slice(0, 40)
                    .join(""),
            };
            if (firstMessage === null) firstMessage = citation;
            if (message.role === "user") return citation;
        }
    }
    return firstMessage ?? { messageLabel: "m1", quote: "" };
};

const smokeAdapter = (testCase) => async () => ({
    output: {
        candidates: testCase.expected.map((expected) => ({
            kind: expected.kind,
            polarity: expected.polarity ?? "affirmed",
            statement: `The user's record: ${expected.mustInclude.join(" ")}.`,
            confidence: 0.9,
            sensitivity:
                expected.expectedDisposition === "sensitive_review"
                    ? "sensitive"
                    : "standard",
            expiresAt: null,
            evidence: [smokeCitation(testCase)],
        })),
    },
});

const contentDigest = (value) =>
    createHash("sha256").update(value, "utf8").digest("hex");

/* ------------------------------------------------------------------ run -- */

const outcomes = [];
const records = [];

for (const testCase of MEMORY_EVAL_DEVELOPMENT_PROBE_CASES) {
    if (runMode.mode === "live" && accruedCostUsd >= runMode.ceilingUsd) break;
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
        failure = error?.message ?? "adapter threw";
    }
    if (analysis && analysis.decisions.length === 0 && analysis.problems.length > 0) {
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

    const outcome = scoreCaseV2(testCase, candidates, failure);
    outcomes.push(outcome);
    records.push({ caseId: testCase.id, failure, candidates, outcome });
}

const verdict = judgeEvalV2(outcomes);
const aggregate = aggregateOutcomesV2(outcomes);

/* --------------------------------------------------------------- report -- */

const line = (label, value) => console.log(`  ${label.padEnd(38)} ${value}`);

console.log(
    `\nDevelopment probe — ${modelId}::${MEMORY_EXTRACTION_PROMPT_VERSION}`
);
console.log(
    `  mode: ${runMode.mode === "live" ? "LIVE" : "SMOKE"}   commit: ${commitSha}\n` +
        `  set: ${MEMORY_EVAL_DEVELOPMENT_PROBE_VERSION} ` +
        `(${MEMORY_EVAL_DEVELOPMENT_PROBE_PURPOSE}, schema ${MEMORY_EVAL_DATASET_SCHEMA_VERSION})`
);

/**
 * The point estimate is the readable number here; the Wilson bound is not.
 *
 * At this sample size a perfect run still has a lower bound near 0.74, because
 * that is what "confident it is at least this good" means on seventeen
 * observations. Printing the bound alone would show a flawless probe as a
 * string of failures, and a reader who learns to ignore that section will
 * ignore it on the day it matters. So both are shown, and the ratio comes
 * first.
 */
console.log("\nExtraction accuracy");
line("cases", aggregate.cases);
line("failures", aggregate.failures);
line(
    "precision",
    `${aggregate.precisionNumerator}/${aggregate.precisionDenominator}` +
        (aggregate.precisionDenominator > 0
            ? ` = ${(
                  aggregate.precisionNumerator / aggregate.precisionDenominator
              ).toFixed(3)}`
            : " (nothing to measure)") +
        `   Wilson lower ${aggregate.precisionWilsonLower.toFixed(4)}`
);
line(
    "recall",
    `${aggregate.recallNumerator}/${aggregate.recallDenominator}` +
        (aggregate.recallDenominator > 0
            ? ` = ${(
                  aggregate.recallNumerator / aggregate.recallDenominator
              ).toFixed(3)}`
            : " (nothing to measure)") +
        `   Wilson lower ${aggregate.recallWilsonLower.toFixed(4)}`
);

console.log("\nBulk-activation safety");
line(
    "bulk eligibility recall",
    `${aggregate.bulkEligibilityNumerator}/${aggregate.bulkEligibilityDenominator}` +
        (aggregate.bulkEligibilityDenominator > 0
            ? ` = ${(
                  aggregate.bulkEligibilityNumerator /
                  aggregate.bulkEligibilityDenominator
              ).toFixed(3)}`
            : " (nothing to measure)") +
        `   Wilson lower ${aggregate.bulkEligibilityWilsonLower.toFixed(4)}`
);
line("critical bulk-safe adoptions", aggregate.criticalBulkSafeAdoptions);
line(
    "sensitive-review misclassifications",
    aggregate.sensitiveExpectedBulkSafeViolations
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
}

// The point of a probe: what came back, next to what was expected. Counts
// collapse "wrong", "extra but correct" and "right with a different kind"
// into one number, and those need different responses.
console.log("\nCase by case");
const byId = new Map(
    MEMORY_EVAL_DEVELOPMENT_PROBE_CASES.map((entry) => [entry.id, entry])
);
for (const record of records) {
    const testCase = byId.get(record.caseId);
    console.log(`\n  ${record.caseId}  (${testCase.category}:${testCase.language})`);
    if (record.failure) {
        console.log(`    failed: ${record.failure}`);
        continue;
    }
    if (testCase.expected.length === 0) {
        console.log("    expected: nothing");
    }
    for (const expected of testCase.expected) {
        console.log(
            `    expected: ${expected.kind} [${expected.mustInclude.join(" + ")}]` +
                `  → ${expected.expectedDisposition}`
        );
    }
    if (record.candidates.length === 0) console.log("    returned: nothing");
    for (const candidate of record.candidates) {
        console.log(
            `    returned: ${candidate.kind}  ${candidate.disposition}` +
                `${candidate.bulkSafe ? " (bulk-safe)" : ""}\n` +
                `              ${candidate.statement}`
        );
    }
}

/**
 * Two kinds of "not met", and they need different responses.
 *
 * A Wilson bound below its floor at n=17 says nothing about the run — a
 * flawless probe fails every one of them — so those are separated out and
 * named as what they are. What IS readable at this size is the rest: a
 * zero-tolerance counter that moved, or a case that produced no scoreable
 * answer at all. Those are findings.
 */
const boundFailure = (failure) =>
    failure.includes("lower bound") || failure.includes("below §12.2 floor");
const findings = verdict.failures.filter((failure) => !boundFailure(failure));

if (findings.length > 0) {
    console.log("\nFindings — these are readable at this sample size:");
    for (const failure of findings) console.log(`  - ${failure}`);
} else {
    console.log(
        "\nNo finding. Every zero-tolerance counter is at zero and every case" +
            "\nproduced a scoreable answer."
    );
}
if (verdict.failures.length > findings.length) {
    console.log(
        `\nThe other ${verdict.failures.length - findings.length} unmet rule(s) are ` +
            "Wilson bounds and the §12.2 floor. At this\nsample size a perfect run " +
            "fails all of them, so they are not findings — they are\nwhy this is a probe " +
            "and not an eval."
    );
}

console.log(
    "\nDEVELOPMENT PROBE — not evidence, and it cannot become evidence. The set is\n" +
        "far below the §12.2 floor, so no verdict is available at any quality, and the\n" +
        "artifact records decisionGrade: false. What it answers is whether a number\n" +
        "from this pipeline can be read at all."
);
if (runMode.mode !== "live") {
    console.log(
        "\nSMOKE — no provider was called. The answers came from a stub that is right\n" +
            "on purpose, so these numbers say nothing about the model. What a smoke run\n" +
            "establishes is that the prompt, the parser, the §8.4 validator and the\n" +
            "schema-2 scorer agree end to end."
    );
}
if (runMode.mode === "live") {
    line("accrued cost USD", accruedCostUsd.toFixed(6));
    if (pricingFailures > 0) {
        line("UNPRICED CALLS", `${pricingFailures} — the cost above is a lower bound`);
    }
}
if (workingTreeDirty) {
    console.log(
        "\nWorking tree is dirty, so the commit above does not fully describe what ran."
    );
}

if (jsonPath) {
    const artifact = {
        kind: "memory-extraction-development-probe",
        decisionGrade: false,
        mode: runMode.mode,
        modelId,
        promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
        probeSetVersion: MEMORY_EVAL_DEVELOPMENT_PROBE_VERSION,
        datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
        commitSha,
        workingTreeDirty,
        accruedCostUsd,
        pricingFailures,
        aggregate,
        byLanguage: verdict.byLanguage,
        records,
    };
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`\nWrote ${jsonPath}`);
}
