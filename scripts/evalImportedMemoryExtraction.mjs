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
 *   ... --run-ordinal=1                                  which approved run this is
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
import {
    MEMORY_EXTRACTION_PROMPT_VERSION,
    extractionPromptContract,
} from "../lib/memoryExtractionPrompt.ts";
import { memoryEvalUnimplementedPromptRules } from "../lib/memoryEvalPromptRuleImplementations.ts";
import {
    evalBudgetBindingProblems,
    evalBudgetTupleFailures,
} from "../lib/memoryEvalBudgetBinding.ts";
import {
    MEMORY_EXTRACTION_EVAL_REGISTER,
} from "../lib/memoryExtractionEvalRegister.ts";
// The target, resolved as one object rather than as five imports that must
// move together.
//
// This harness read `mem-eval-seed-11` until 2026-08-26, and would have
// scored the wrong dataset with the wrong scorer. It never could: the gate
// refused it with `legacy_dataset_schema` before any provider was reached,
// which is what fail-closed is for. But a funded pair that cannot run is a
// trap of its own, so the harness moves rather than the gate.
//
// Moved succ-2 → succ-3 on 2026-08-27 and succ-3 → succ-4 on 2026-08-28. The
// harness is pinned to one approved target on purpose -- there is no reason
// to make an arbitrary past dataset billable -- and reading a past one is
// `resolveArtifactDataset`'s job, which needs no provider and cannot spend.
import {
    harnessRunTuple,
    harnessTarget,
    harnessTargetBindingFailures,
} from "../lib/memoryEvalHarnessTarget.ts";
// The artifact envelope version and the second digest. The harness stays
// pinned to the approved current target -- there is no need to make an
// arbitrary past dataset billable -- but what it writes has to say which
// version and which labelling it ran on, or a later reader has to guess.
import { MEMORY_EVAL_ARTIFACT_SCHEMA } from "../lib/memoryEvalDatasetRegistry.ts";
import { MEMORY_EVAL_SCORING_CONTRACT_VERSION } from "../lib/memoryEvalScoringContractDigest.ts";
import {
    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM,
    decideEvalRunMode,
    findDuplicateCases,
    summarizeFailures,
} from "../lib/memoryExtractionEvalCore.ts";
import { judgeEvalV2, scoreCaseV2 } from "../lib/memoryEvalScoringV2.ts";
// The schema a live run is pinned to, which is a different question from the
// schema this harness scores. Imported under a name that says which is which.
// From the core module, which owns the gate: the schema module exports the
// same name meaning "the schema this module defines", and that is 2 forever.
import { MEMORY_EVAL_DATASET_SCHEMA_VERSION as GATE_DATASET_SCHEMA_VERSION } from "../lib/memoryExtractionEvalCore.ts";
import { judgeEvalV3, scoreCaseV3 } from "../lib/memoryEvalScoringV3.ts";
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

/**
 * Which of the approved runs this invocation is, counting from 1.
 *
 * The budget approves a number of provider-dispatched runs and this
 * repository keeps no ledger of them: `accruedCostUsd` starts at zero every
 * time, and nothing here can read what a previous invocation spent. So the
 * operator states the ordinal and the gate holds it against the approval,
 * which turns the explicit instruction to run into the ledger it already was
 * procedurally -- and makes a run past the approved count refuse rather than
 * depend on somebody remembering how many have happened.
 *
 * Required for `--live` when the budget names a run count. Not defaulted to
 * 1: a default would make every unstated run the first one, which is the
 * failure this exists to prevent.
 */
const rawRunOrdinal = argValue("run-ordinal", "");
const runOrdinal = rawRunOrdinal === "" ? undefined : Number(rawRunOrdinal);
if (runOrdinal !== undefined && !(Number.isInteger(runOrdinal) && runOrdinal > 0)) {
    console.error(`--run-ordinal must be a positive integer (got "${rawRunOrdinal}").`);
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

/**
 * Whether HEAD descends from the commit the budget was approved against.
 *
 * `undefined` when git cannot answer — no repository, a shallow clone that
 * does not contain the approved commit — and `decideEvalRunMode()` treats that
 * as a refusal rather than a pass. An ancestry nobody could check is an
 * ancestry nobody has.
 *
 * Not an equality: a registration PR cannot contain its own merge SHA, and a
 * later commit that still assembles the approved instrument is running it.
 */
const descendsFrom = (ancestor) => {
    if (!ancestor || commitSha === "unknown") return undefined;
    try {
        execFileSync("git", ["merge-base", "--is-ancestor", ancestor, commitSha], {
            stdio: "ignore",
        });
        return true;
    } catch (error) {
        // Exit 1 is a clean "no". Anything else — an unknown object in a
        // shallow clone, git missing — is "could not tell", which refuses too
        // but for a different reason a reader needs to see.
        return error?.status === 1 ? false : undefined;
    }
};

/** Provider messages may echo a key; nothing key-shaped reaches the artifact. */
const redactSecrets = (message) => {
    const key = process.env.OPENAI_API_KEY?.trim();
    return (key ? String(message).split(key).join("[REDACTED_API_KEY]") : String(message))
        .replace(/\b(sk|rk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED_API_KEY]")
        .replace(/(authorization|api[-_]?key)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]");
};

/**
 * The target, and the digests that tie an archived verdict to the exact
 * sample it was computed from (§12.2).
 *
 * Both digests come from the target rather than being computed here, because
 * which function computes them is a property of the schema: schema 2
 * fingerprints with `datasetFingerprintInput()` and hashes the contract
 * descriptor together with a labelling pass, schema 3 fingerprints with
 * `datasetFingerprintInputV3()` and hashes the descriptor alone. Computing
 * either one here would be a fourth copy of that decision.
 */
// What the model would actually be asked, as one digest. The budget is bound
// to it, so a prompt edited without a version bump refuses the run rather than
// spending against an approval for different words.
const promptContractDigest = createHash("sha256")
    .update(extractionPromptContract(), "utf8")
    .digest("hex");

const target = harnessTarget();
const MEMORY_EVAL_CASES = target.cases;
const MEMORY_EVAL_DATASET_VERSION = target.datasetVersion;
const MEMORY_EVAL_DATASET_FROZEN = target.datasetFrozen;
const MEMORY_EVAL_DATASET_PURPOSE = target.datasetPurpose;
const MEMORY_EVAL_DATASET_SCHEMA_VERSION = target.datasetSchemaVersion;
const datasetDigest = target.datasetDigest;
const scoringContractDigest = target.scoringContractDigest;

// The scorer is chosen by the target's schema and nowhere else. A harness
// that named one directly is how a schema-3 sample would be scored by the
// schema-2 rules -- every candidate's polarity ignored and every citation
// unchecked, reported under the schema-3 contract's name.
const scoreCase = MEMORY_EVAL_DATASET_SCHEMA_VERSION === 3 ? scoreCaseV3 : scoreCaseV2;
const judgeEval = MEMORY_EVAL_DATASET_SCHEMA_VERSION === 3 ? judgeEvalV3 : judgeEvalV2;

const contentDigest = (content) =>
    createHash("sha256")
        .update(content.normalize("NFC").replace(/\r\n?/g, "\n"), "utf8")
        .digest("hex");

/* ------------------------------------------------------------------ gates -- */

// The dataset this tree holds must be the one the manifest recorded, and the
// contract must be the one it was recorded under. Checked before the register
// and before any provider: a run whose sample fingerprints differently from
// the frozen record is not the run anybody approved, and finding that out
// afterwards means the money is already spent.
const bindingFailures = harnessTargetBindingFailures(target);
if (bindingFailures.length > 0) {
    console.error(
        `\n${MEMORY_EVAL_DATASET_VERSION} does not match its recorded manifest:\n  ` +
            bindingFailures.join("\n  ") +
            "\n\nThe manifest is the record. Restore the dataset, or record a new " +
            "manifest deliberately as its own reviewed change -- an artifact from a " +
            "run that disagreed with its manifest cannot be resolved by any reader.\n"
    );
    process.exit(1);
}

/**
 * What this run would actually assemble, against what the budget approved.
 *
 * Seven values and an ancestry. The 2026-08-28 re-approval says the approval
 * "loses effect immediately" if any of them differs, and a sentence cannot do
 * that — so it is computed here, before the register is even consulted, and
 * handed to the gate.
 */
const budgetBindingFor = (entry) => {
    const budget = entry?.evalBudget;
    if (!budget) return { problems: [], tupleFailures: [], descends: undefined };
    const problems = evalBudgetBindingProblems(budget);
    if (problems.length > 0) {
        return { problems, tupleFailures: [], descends: undefined };
    }
    return {
        problems,
        // Built by `harnessRunTuple()` rather than assembled here. This
        // object used to name `MEMORY_EVAL_SUCC5_MANIFEST` directly, which
        // meant pointing the harness at another dataset left the tuple
        // describing the old one — and the mismatch would only have surfaced
        // as a refusal at spend time.
        tupleFailures: evalBudgetTupleFailures(
            budget.boundTuple,
            harnessRunTuple({
                target,
                promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
                promptDigest: promptContractDigest,
            })
        ),
        descends: descendsFrom(budget.approvedImplementationSha),
    };
};

const registerEntry = MEMORY_EXTRACTION_EVAL_REGISTER.find(
    (entry) =>
        entry.extractionModelId === modelId &&
        entry.promptVersion === MEMORY_EXTRACTION_PROMPT_VERSION
);
const budgetBinding = budgetBindingFor(registerEntry);

// Only a live run needs a registered pair. `decideEvalRunMode()` answers
// `smoke` before it looks at the register at all, and `unknown_pair` when a
// live run has no entry, so this check adds nothing to the live path and used
// to take the smoke path down with it: bumping `promptVersion` made the
// harness unrunnable in every mode until somebody registered a pair, which is
// a separate approval. A smoke run reaches no provider and spends nothing, and
// refusing it protects no budget.
//
// Kept as an early exit rather than deferred to the refusal below because the
// message names the file to edit, which `unknown_pair` does not.
if (!registerEntry && live) {
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
    // Rules the scoring contract puts on the prompt that the prompt this run
    // would send does not implement. Resolved from the shipped
    // `promptVersion` rather than named, for the reason the network-guard
    // test learned the hard way: a gate that names a version keeps passing
    // after the tree moves past it.
    unimplementedPromptRules: memoryEvalUnimplementedPromptRules(
        MEMORY_EXTRACTION_PROMPT_VERSION
    ),
    // The budget's own binding: is it bound to an instrument at all, is this
    // that instrument, and does this commit descend from the approved one.
    // Computed here because two of the three need the tree and the third needs
    // git, and `decideEvalRunMode()` stays a pure truth table.
    budgetBindingProblems: budgetBinding.problems,
    budgetTupleFailures: budgetBinding.tupleFailures,
    runShaDescendsFromApproval: budgetBinding.descends,
    // Stated on the command line, because nothing in the tree can count runs.
    runOrdinal,
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
        `and a live run is pinned to schema ${GATE_DATASET_SCHEMA_VERSION} ` +
        "(§12.2, amended 2026-08-25).\n\n" +
        (MEMORY_EVAL_DATASET_SCHEMA_VERSION > GATE_DATASET_SCHEMA_VERSION
            ? "The dataset is ahead of the gate, not behind it. This tree can score\n" +
              "schema 3 -- the scorer, the artifact envelope and the artifact readers\n" +
              "are all converted -- and the gate is held deliberately until the last\n" +
              "consumer is, so that a paid run cannot produce an artifact something\n" +
              "downstream still reads under the wrong contract.\n\n" +
              "  npm run report:memory-eval-schema-readiness\n\n" +
              "lists every consumer and what each still needs. Moving the gate is its\n" +
              "own reviewed change, taken when that report is clean -- and it opens\n" +
              "nothing on its own: a live run still needs the §12.5 budget approval,\n" +
              "which names the pair, the digests, the run count and the ceiling."
            : "It carries neither `expectedDisposition` nor `goldCompleteness`, so\n" +
              "bulk eligibility recall and the sensitive-review bulk-safe\n" +
              "misclassification count cannot be computed against it. A run would\n" +
              "still print numbers, and that is the danger: they would be the old\n" +
              "contract's numbers under the new contract's names.\n\n" +
              "Reproducing the mem-extract-v2 diagnostics is a separate path --\n" +
              "lib/memoryEvalLegacyDataset.ts, which is not a live run and cannot\n" +
              "support a verdict, a freeze or a pair approval."),
    prompt_rule_unimplemented:
        `${MEMORY_EXTRACTION_PROMPT_VERSION} does not implement every scoring rule the ` +
        "contract puts on the prompt:\n" +
        memoryEvalUnimplementedPromptRules(MEMORY_EXTRACTION_PROMPT_VERSION)
            .map((ruleId) => `  ${ruleId}`)
            .join("\n") +
        "\n\nThe run would report against a rule nothing applied, which is how a\n" +
        "contract's numbers end up wearing a name nothing earned. Implement the\n" +
        "rule in the prompt, bump the prompt version, and record the version\n" +
        "against the rule id in lib/memoryEvalPromptRuleImplementations.ts --\n" +
        "the mapping is written by whoever writes the rule into the prompt, and\n" +
        "is deliberately not derived by searching the prompt for words.",
    budget_not_bound:
        `${modelId}::${MEMORY_EXTRACTION_PROMPT_VERSION} has a budget that is not bound ` +
        "to an instrument:\n" +
        budgetBinding.problems.map((problem) => `  ${problem}`).join("\n") +
        "\n\nA ceiling with no dataset, contract or prompt digest authorises a run\n" +
        "whose shape nobody approved. Budgets recorded before 2026-08-28 are like\n" +
        "this and stay on the register as history; they cannot fund a run.",
    budget_tuple_mismatch:
        "This run would not assemble the instrument the budget was approved for:\n" +
        budgetBinding.tupleFailures.map((line) => `  ${line}`).join("\n") +
        "\n\nThe 2026-08-28 approval says it loses effect immediately if any of the\n" +
        "dataset, contract or prompt version or digest differs. Re-approval names\n" +
        "the new values; editing them here would spend against an approval that\n" +
        "no longer exists.",
    run_sha_not_descendant:
        `This run's commit does not descend from the approved implementation.\n\n` +
        `  approvedImplementationSha  ${String(registerEntry?.evalBudget?.approvedImplementationSha)}\n` +
        `  this run                   ${commitSha}\n\n` +
        (budgetBinding.descends === undefined
            ? "git could not answer -- no repository, or a shallow clone that does not\n" +
              "contain the approved commit. An ancestry nobody could check is an\n" +
              "ancestry nobody has, so it refuses rather than passing.\n\n"
            : "") +
        "Equality is not required and never was: a registration PR cannot contain\n" +
        "its own merge SHA. What is required is that this commit descends from the\n" +
        "approved one and assembles the same three digests.",
    run_ordinal_not_approved:
        `--run-ordinal=${rawRunOrdinal || "(absent)"} is not one of the runs this budget ` +
        `approves (1..${String(registerEntry?.evalBudget?.maxProviderDispatchedRuns)}).\n\n` +
        "The approval covers a fixed number of provider-dispatched runs and this\n" +
        "repository keeps no ledger of them -- every invocation starts its spend\n" +
        "at zero. So the invocation says which run it is and this gate holds it\n" +
        "against the approval.\n\n" +
        "The second run is the §12.4 reproducibility run, started only on an\n" +
        "explicit instruction after the first has been reviewed; unused budget\n" +
        "from the first does not carry into it. A run beyond the approved count\n" +
        "needs a new budget approval, recorded on the register, not a larger\n" +
        "number here.",
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
 * The statement satisfies `mustIncludeAny` as well as `mustInclude`, for the
 * same reason. A correct extractor answering a gold that states a polarity
 * writes that polarity; a stub that wrote only the conjunction misses its own
 * gold, and on 2026-08-27 that reported 14 critical bulk-safe adoptions on
 * `mem-eval-succ-3` — one per `mustIncludeAny` gold in a critical category,
 * and none of them about the pipeline.
 *
 * Evidence cites the first user message: the label map decides the role, so a
 * smoke answer cannot smuggle assistant-only evidence past the validator.
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
/**
 * The label the prompt will have issued for one of a case's messages.
 *
 * Labels are assigned by position across the whole chunk, starting at one, by
 * `toExtractionPromptInput()`. This walks the same order rather than
 * reimplementing the rule: the two agreeing is what makes a cited label
 * resolve at all.
 */
/**
 * A gold's required tokens, whichever schema wrote it.
 *
 * Schema 3 renamed `mustInclude` to `factValueAll`. Read here rather than
 * translated at the boundary: a printout that read the wrong field would show
 * an empty token list and report every candidate as "kind matches, tokens do
 * not" — a diagnosis about this script.
 */
const goldTokens = (gold) => gold.factValueAll ?? gold.mustInclude ?? [];

const smokeLabelFor = (testCase, externalMessageId) => {
    let ordinal = 0;
    for (const conversation of testCase.conversations) {
        for (const message of conversation.messages) {
            ordinal += 1;
            if (message.externalMessageId === externalMessageId) {
                return `m${ordinal}`;
            }
        }
    }
    return "m1";
};

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
            // The gold's own polarity where the schema carries one; schema 2
            // has no such field and does not score it either.
            polarity: expected.polarity ?? "affirmed",
            // Schema 3 renamed the token lists. Both are read rather than one
            // being translated into the other: a stub that answered the wrong
            // schema's field would return a statement containing none of the
            // gold's tokens, and every case would score as a miss for a reason
            // that is about the stub.
            statement: `The user's record: ${[
                ...(expected.factValueAll ?? expected.mustInclude ?? []),
                ...(expected.factValueAny ?? expected.mustIncludeAny ?? []).slice(
                    0,
                    1
                ),
            ].join(" ")}.`,
            confidence: 0.9,
            sensitivity:
                expected.expectedDisposition === "sensitive_review"
                    ? "sensitive"
                    : "standard",
            expiresAt: null,
            // A schema-3 gold names the span it was written from, and scoring
            // re-reads it. Citing the gold's own anchor is what a correct
            // extractor would do, and it is the only citation guaranteed to
            // resolve — `smokeCitation` picks the first user message, which
            // for a multi-conversation case need not be the one the gold cites.
            evidence: [
                expected.evidence
                    ? {
                          messageLabel: smokeLabelFor(
                              testCase,
                              expected.evidence.evidenceMessageId
                          ),
                          quote: expected.evidence.evidenceQuote,
                      }
                    : smokeCitation(testCase),
            ],
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

    // Schema 3 scores two fields schema 2 does not have, so both are carried
    // here rather than at the scorer's door. `evidence` is what the parser
    // resolved -- the server's own message id and the quote it already checked
    // -- never what the model typed, and the scorer re-checks it against the
    // case's conversation anyway.
    const candidates = (analysis?.decisions ?? []).map((decision) => ({
        kind: decision.candidate.kind,
        polarity: decision.candidate.polarity,
        statement: decision.candidate.statement,
        bulkSafe: decision.validation.bulkSafe,
        disposition: decision.validation.disposition,
        evidence: decision.candidate.evidence.map((reference) => ({
            evidenceMessageId: reference.externalMessageId,
            evidenceQuote: reference.evidenceQuote,
        })),
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
        `${MEMORY_EVAL_DATASET_FROZEN ? "frozen" : "not frozen"})  digest: ${datasetDigest.slice(0, 16)}…\n` +
        // The manifest digest as well as the sample's. The dataset digest says
        // which cases ran; the manifest digest is what the signature was given
        // for, and it covers what the sample cannot — the retired-to-
        // replacement pairing among them. A header naming only the first
        // leaves a reader unable to tell which record this run answers to.
        `  manifest: ${
            target.datasetManifestDigest
                ? `${target.datasetManifestDigest.slice(0, 16)}…`
                : "none recorded (schema-2 dataset)"
        }  binding: verified against the recorded manifest`
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
                      .map(
                          (entry) =>
                              `${entry.kind}${entry.polarity ? `/${entry.polarity}` : ""} + [${goldTokens(entry).join(", ")}]`
                      )
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
                goldTokens(entry).every((token) =>
                    candidate.statement.toLowerCase().includes(token.toLowerCase())
                )
            );
            // Schema 3 only. A statement can carry every gold token and still
            // claim the opposite, and it can be right and cite nothing — two
            // failures that read identically in the totals and need different
            // answers from a person.
            const polarityMatches =
                candidate.polarity === undefined ||
                expected.some((entry) => entry.polarity === candidate.polarity);
            const cited =
                candidate.evidence === undefined ||
                candidate.evidence.length > 0;
            const verdict = !candidate.bulkSafe
                ? "not adopted"
                : !polarityMatches
                  ? `polarity differs (expected ${expected.map((e) => e.polarity).join("/")})`
                  : kindMatches && tokensMatch
                    ? "MATCH"
                    : tokensMatch
                      ? `tokens match, kind differs (expected ${expected.map((e) => e.kind).join("/")})`
                      : kindMatches
                        ? "kind matches, tokens do not"
                        : "neither";
            console.log(
                `    [${verdict}] ${candidate.kind}${candidate.polarity ? `/${candidate.polarity}` : ""} · ` +
                    `bulk-safe ${candidate.bulkSafe}${cited ? "" : " · uncited"} — ${candidate.statement}`
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
/**
 * Did the run finish having spent more than its ceiling?
 *
 * A different question from `costStopped`, and it went unasked. The loop
 * compares `accruedCostUsd` against the ceiling **before dispatching the next
 * case**, and cost is added **after** a response comes back, so the last call
 * of a run is never checked: a run whose final response carried it past the
 * ceiling ends with `costStopped === false` and reads as decision-grade.
 *
 * This does not stop the spend — the money is gone by the time it can be
 * observed, and stopping it would mean reserving the next call's cost before
 * dispatch, against an estimate whose accuracy is the open question in the
 * budget proposal. What it stops is the *citation*: a run that spent more than
 * was approved is not the run that was approved, whatever its numbers say.
 */
const ceilingExceeded =
    runMode.mode === "live" && accruedCostUsd > runMode.ceilingUsd;

if (ceilingExceeded && !costStopped) {
    console.log(
        `\nOVER CEILING — finished having spent US$${accruedCostUsd.toFixed(4)} ` +
            `against an approved US$${runMode.ceilingUsd}.\n` +
            "The loop checks the ceiling before each dispatch and cost is added after\n" +
            "each response, so the last call was not checked BEFORE it was spent. It is\n" +
            "checked now, which is what this line is. The money is already gone; what\n" +
            "this refuses is the claim that the run was the one approved. Not\n" +
            "decision-grade, and the answer is a fresh approval rather than a note\n" +
            "explaining the overrun."
    );
}
if (costStopped) {
    console.log(
        `\nTRUNCATED — stopped at the US$${runMode.ceilingUsd} ceiling after ` +
            `${outcomes.length}/${MEMORY_EVAL_CASES.length} cases. The missing cases were planned, not absent.\n` +
            "This run is not decision-grade whatever its numbers say: the cases it\n" +
            "scored are the ones the money reached, not a sample anybody chose. The\n" +
            "answer is a fresh budget approval, not a larger ceiling here."
    );
}
if (runMode.mode === "live") {
    line("\naccrued cost (USD, estimate)", accruedCostUsd.toFixed(4));
    if (registerEntry?.evalBudget) {
        line("approved ceiling, this run (USD)", registerEntry.evalBudget.maxUsd);
        const { programmeMaxMicroUsd, maxProviderDispatchedRuns } =
            registerEntry.evalBudget;
        if (programmeMaxMicroUsd !== undefined) {
            line(
                "approved programme total (USD)",
                (programmeMaxMicroUsd / 1_000_000).toFixed(6)
            );
        }
        if (maxProviderDispatchedRuns !== undefined) {
            line(
                "run",
                `${String(runOrdinal)} of ${maxProviderDispatchedRuns} approved`
            );
        }
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
        // Which schema the sample is written in, and therefore which scorer
        // produced the numbers below. A reader can derive it from the version
        // via the manifest, and deriving it is exactly what leaves a
        // disagreement invisible: an artifact that names a schema its dataset
        // is not recorded under is refused rather than resolved.
        datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
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
        // Recorded separately from the truncation: one says the run stopped
        // early, the other that it finished having spent more than approved.
        exceededCostCeiling: ceilingExceeded,
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
        // Decision-grade needs all of: a live run, a sample at the §12.2
        // floor, a frozen dataset, the whole sample rather than a probe, and
        // a run that was not cut short at its spend ceiling. Any one missing
        // and the artifact says so.
        //
        // The last of those was added with the per-run ceiling on 2026-08-28.
        // A run truncated at the ceiling scored some prefix of the sample and
        // stopped, and `adequacy.decisionGrade` reads the case count it did
        // score -- so a truncation that still cleared the §12.2 floor would
        // have produced a decision-grade verdict over a sample chosen by
        // where the money ran out. The approval's answer to a truncated run
        // is not a larger ceiling but a fresh approval, so the artifact must
        // not present one as citable.
        decisionGrade:
            verdict.adequacy.decisionGrade &&
            runMode.mode === "live" &&
            MEMORY_EVAL_DATASET_FROZEN &&
            probeLimit === null &&
            !costStopped &&
            // And not over it either. The check above catches a run cut short
            // by the ceiling; this catches one that ran past it on its last
            // call, which the pre-dispatch comparison cannot see.
            !ceilingExceeded,
        datasetFrozen: MEMORY_EVAL_DATASET_FROZEN,
        datasetPurpose: MEMORY_EVAL_DATASET_PURPOSE,
        abortedOnConsecutiveFailures: abortedOnFailures,
        runCeilingUsd: runMode.mode === "live" ? runMode.ceilingUsd : null,
        // Which approved run this was, and the two figures that make the
        // per-run number readable. `runCeilingUsd` above is what this
        // invocation was allowed to spend after any --max-cost-usd narrowing;
        // `perRunCeilingUsd` is what the approval allows a run, and
        // `programmeMaxMicroUsd` is what it allows in total. Recorded
        // together because a reader holding one artifact cannot otherwise
        // tell a per-run ceiling from a programme one -- which is the
        // confusion this pass was correcting.
        runOrdinal: runMode.mode === "live" ? (runOrdinal ?? null) : null,
        perRunCeilingUsd: registerEntry?.evalBudget?.maxUsd ?? null,
        approvedRunCount:
            registerEntry?.evalBudget?.maxProviderDispatchedRuns ?? null,
        programmeMaxMicroUsd:
            registerEntry?.evalBudget?.programmeMaxMicroUsd ?? null,
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
