import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MEMORY_EXTRACTION_EVAL_REGISTER } from "../lib/memoryExtractionEvalRegister.ts";
import { findApprovedEvalPair } from "../lib/memoryExtractionEvalRegister.ts";
import { decideEvalRunMode } from "../lib/memoryExtractionEvalCore.ts";
import { MEMORY_EVAL_DATASET_FROZEN } from "../lib/memoryExtractionEvalFixtures.ts";

/**
 * The execution boundary: no provider is reached without every gate.
 *
 * tests/memoryExtractionOfflineBoundary.test.mjs checks the *import graph* of
 * the offline modules, which is a different and weaker claim. The eval
 * harness deliberately reaches an AI SDK, and it does so through a dynamic
 * `import("ai")` that a static import scan cannot see at all. So the guarantee
 * has to be established two other ways, and both are here:
 *
 *   * the gate is a pure function, checked as a truth table;
 *   * the script is actually executed with `--live`, a plausible key, and
 *     outbound network blocked, and must exit before anything connects.
 *
 * The second one is the part that would survive a refactor: whatever the
 * control flow becomes, a run that reaches a socket fails this test.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HARNESS = "scripts/evalImportedMemoryExtraction.mjs";
const NETWORK_GUARD = fileURLToPath(
    new URL("./e2e/block-external-network.cjs", import.meta.url)
);

const budgeted = { evalBudget: { maxUsd: 50 } };

/* ------------------------------------------------------------ truth table -- */

test("a run without --live is smoke, whatever else is present", () => {
    assert.deepEqual(
        decideEvalRunMode({
            live: false,
            registerEntry: budgeted,
            hasApiKey: true,
            datasetFrozen: true,
        }),
        { mode: "smoke" }
    );
    // …and still smoke when nothing at all is configured.
    assert.deepEqual(
        decideEvalRunMode({
            live: false,
            registerEntry: null,
            hasApiKey: false,
            datasetFrozen: false,
        }),
        { mode: "smoke" }
    );
});

test("every missing precondition refuses a live run", () => {
    const cases = [
        [{ registerEntry: null, hasApiKey: true, datasetFrozen: true }, "unknown_pair"],
        [
            { registerEntry: { evalBudget: null }, hasApiKey: true, datasetFrozen: true },
            "no_eval_budget",
        ],
        [
            { registerEntry: budgeted, hasApiKey: false, datasetFrozen: true },
            "no_api_key",
        ],
        [
            { registerEntry: budgeted, hasApiKey: true, datasetFrozen: false },
            "dataset_not_frozen",
        ],
    ];
    for (const [input, reason] of cases) {
        const decision = decideEvalRunMode({ live: true, ...input });
        assert.equal(decision.mode, "refused", `${reason} must refuse`);
        assert.equal(decision.reason, reason);
    }
});

test("only every precondition together allows a live run", () => {
    const decision = decideEvalRunMode({
        live: true,
        registerEntry: budgeted,
        hasApiKey: true,
        datasetFrozen: true,
    });
    assert.equal(decision.mode, "live");
    assert.equal(decision.ceilingUsd, 50);
});

test("a per-run cap may narrow the approved ceiling but never widen it", () => {
    const narrowed = decideEvalRunMode({
        live: true,
        registerEntry: budgeted,
        hasApiKey: true,
        datasetFrozen: true,
        requestedRunCapUsd: 5,
    });
    assert.equal(narrowed.mode, "live");
    assert.equal(narrowed.ceilingUsd, 5, "the tighter of the two wins");

    const widened = decideEvalRunMode({
        live: true,
        registerEntry: budgeted,
        hasApiKey: true,
        datasetFrozen: true,
        requestedRunCapUsd: 500,
    });
    assert.equal(widened.mode, "refused");
    assert.equal(widened.reason, "run_cap_above_approved_ceiling");
});

/* ------------------------------------------------------- shipped register -- */

test("only the funded pair can run live against the shipped dataset", () => {
    // Both entries used to be refused, first for want of a budget and then
    // because the dataset was still moving. The dataset was frozen on
    // 2026-08-24 (docs/ops/memory-extraction-eval-dataset.md §7.2), so what
    // stops a pair now is the budget alone -- which is the state
    // docs/policy/external-conversation-import-and-memory.md §12.5 describes,
    // and the point of freezing.
    //
    // `datasetFrozen` is read from the fixtures rather than forced. Forcing it
    // asserts a world of the test's own making, and the value that ships is
    // the only one that decides what an operator can actually run.
    assert.equal(
        MEMORY_EVAL_DATASET_FROZEN,
        true,
        "this test describes the frozen dataset that shipped"
    );
    for (const entry of MEMORY_EXTRACTION_EVAL_REGISTER) {
        const decision = decideEvalRunMode({
            live: true,
            registerEntry: entry,
            hasApiKey: true,
            datasetFrozen: MEMORY_EVAL_DATASET_FROZEN,
        });
        if (entry.evalBudget) {
            assert.equal(
                decision.mode,
                "live",
                `${entry.extractionModelId} has an approved budget and a frozen dataset`
            );
            assert.equal(decision.ceilingUsd, entry.evalBudget.maxUsd);
        } else {
            assert.equal(
                decision.mode,
                "refused",
                `${entry.extractionModelId} must not be live-runnable as shipped`
            );
            assert.equal(decision.reason, "no_eval_budget");
        }
    }
});

test("a live run still needs an API key the environment may not have", () => {
    // Freezing removed one refusal and must not have removed another. Without
    // a key the funded pair is refused for the key, not waved through on the
    // strength of its budget.
    for (const entry of MEMORY_EXTRACTION_EVAL_REGISTER) {
        const decision = decideEvalRunMode({
            live: true,
            registerEntry: entry,
            hasApiKey: false,
            datasetFrozen: MEMORY_EVAL_DATASET_FROZEN,
        });
        assert.equal(decision.mode, "refused", `${entry.extractionModelId}`);
        assert.equal(
            decision.reason,
            entry.evalBudget ? "no_api_key" : "no_eval_budget",
            `${entry.extractionModelId} should name the first gate it fails`
        );
    }
});

test("the budget is the only gate an approval opens", () => {
    // What approving a budget bought, stated exactly. The funded pair stops
    // being refused *for want of a budget* and goes on being refused for every
    // other reason -- and the unfunded one is untouched. An approval that
    // quietly relaxed a second rule would be an approval nobody gave.
    const funded = MEMORY_EXTRACTION_EVAL_REGISTER.filter((e) => e.evalBudget);
    const unfunded = MEMORY_EXTRACTION_EVAL_REGISTER.filter((e) => !e.evalBudget);
    assert.ok(funded.length > 0 && unfunded.length > 0, "expected one of each");

    for (const entry of funded) {
        const decision = decideEvalRunMode({
            live: true,
            registerEntry: entry,
            hasApiKey: true,
            datasetFrozen: true,
        });
        assert.equal(decision.mode, "live", `${entry.extractionModelId}`);
        assert.equal(decision.ceilingUsd, entry.evalBudget.maxUsd);
    }
    for (const entry of unfunded) {
        const decision = decideEvalRunMode({
            live: true,
            registerEntry: entry,
            hasApiKey: true,
            datasetFrozen: true,
        });
        assert.equal(decision.mode, "refused", `${entry.extractionModelId}`);
    }
});

test("no pair in the shipped register resolves as approved for runtime use", () => {
    // The other half of the same contract: even with the flag on, the product
    // runtime finds no approved pair, so extraction fails closed (§12.1).
    for (const entry of MEMORY_EXTRACTION_EVAL_REGISTER) {
        assert.equal(
            findApprovedEvalPair(
                {
                    extractionModelId: entry.extractionModelId,
                    promptVersion: entry.promptVersion,
                },
                { kind: "none" }
            ),
            null,
            `${entry.extractionModelId} must not resolve as approved`
        );
    }
});

/* ------------------------------------------------------------- behaviour -- */

const runHarness = (args, env = {}) => {
    try {
        const stdout = execFileSync(
            process.execPath,
            [
                // The same blocker the E2E server runs under: any non-loopback
                // connection throws instead of dialling out.
                "--require",
                NETWORK_GUARD,
                "--import",
                "tsx",
                HARNESS,
                ...args,
            ],
            {
                cwd: REPO_ROOT,
                encoding: "utf8",
                env: { ...process.env, ...env },
                stdio: ["ignore", "pipe", "pipe"],
            }
        );
        return { status: 0, output: stdout };
    } catch (error) {
        return {
            status: error.status ?? 1,
            output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
        };
    }
};

test("--live with a key but no approved budget never reaches the network", () => {
    // Named explicitly rather than relying on the default pair. The default is
    // funded now (docs/policy/external-conversation-import-and-memory.md §12.5,
    // issue #837), and a test that reads "no budget" from whichever pair
    // happens to be default stops testing the budget refusal the moment one is
    // approved -- silently, while still passing on a different rule.
    const result = runHarness(["--live", "--model=gpt-5-4-mini"], {
        // Plausible enough that a missing-key check could not be what stops it.
        OPENAI_API_KEY: "sk-test-EXAMPLE-not-a-real-key-000000000000",
    });
    assert.equal(result.status, 1, "the run must refuse");
    assert.match(result.output, /no approved eval budget/i);
    assert.doesNotMatch(
        result.output,
        /QA_EXTERNAL_NETWORK_BLOCKED/,
        "nothing may attempt an outbound connection before the refusal"
    );
});

test("a funded pair with no key refuses, and still reaches no network", () => {
    // Recording a budget opens `--live`; it does not open the run. Two gates
    // used to stand after the budget check and the dataset freeze took one of
    // them away, so this test now exercises the one that is left. The
    // guarantee it protects is unchanged and is the reason it exists: funding
    // alone must never be the thing that lets a call out.
    const result = runHarness(["--live", "--model=gpt-5-6-luna"], {
        OPENAI_API_KEY: "",
    });
    assert.equal(result.status, 1, "the run must refuse");
    assert.doesNotMatch(result.output, /no approved eval budget/i);
    assert.doesNotMatch(result.output, /is not frozen/i);
    assert.match(result.output, /OPENAI_API_KEY/);
    assert.doesNotMatch(
        result.output,
        /QA_EXTERNAL_NETWORK_BLOCKED/,
        "a funded pair must still not dial out"
    );
});

test("a smoke run completes without touching the network", () => {
    const result = runHarness([]);
    // Exit 0 since the 2026-08-23 promotion: every cell is at its §12.2 floor,
    // so the run is no longer UNDERPOWERED. It used to exit 1 on that rule,
    // and the change is the dataset's, not the harness's.
    assert.equal(result.status, 0);
    assert.match(result.output, /SMOKE RUN/);
    assert.doesNotMatch(result.output, /UNDERPOWERED/);
    assert.doesNotMatch(result.output, /QA_EXTERNAL_NETWORK_BLOCKED/);
});

test("a smoke run that passes every rule still says it proves nothing", () => {
    // The dangerous shape now that the floor is met and the dataset is frozen:
    // a stub agreeing with itself prints "Every §12.3 rule passed", and without
    // the caveat beside it that reads like a decision-grade result. The freeze
    // removed the second disclaimer this test used to lean on ("not frozen"),
    // which makes the first one load-bearing -- so it is asserted on its own,
    // beside the dataset line that now reads `decision, frozen`.
    const result = runHarness([]);
    assert.match(result.output, /SMOKE RUN — NOT an eval result/);
    assert.match(result.output, /No provider was called/);
    assert.match(result.output, /\(decision, frozen\)/);
    assert.doesNotMatch(result.output, /not frozen/);
});

/* ---------------------------------------------------------------- static -- */

test("the harness imports no provider SDK at module load", () => {
    const source = readFileSync(new URL(`../${HARNESS}`, import.meta.url), "utf8");
    const staticImports = [
        ...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm),
    ].map((match) => match[1]);
    for (const forbidden of ["ai", "@ai-sdk/openai", "openai", "@/lib/prisma"]) {
        assert.ok(
            !staticImports.includes(forbidden),
            `${HARNESS} statically imports ${forbidden}; it must stay behind the live gate`
        );
    }
    // And the dynamic one exists, so the behavioural test above is meaningful
    // rather than passing because nothing could ever call a provider.
    assert.match(
        source,
        /import\(\s*["']ai["']\s*\)/,
        "the live adapter should reach the SDK dynamically"
    );
});
