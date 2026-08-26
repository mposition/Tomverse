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
            commitKnown: true,
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
        // A deployed container has no git metadata, so `commitSha` is
        // "unknown" and `workingTreeDirty` is `false` -- an artifact that
        // reads as a clean checkout while being impossible to tie to a
        // commit. Refused before the calls, not after.
        [
            {
                registerEntry: budgeted,
                hasApiKey: true,
                datasetFrozen: true,
                commitKnown: false,
            },
            "unknown_commit",
        ],
        // `mem-eval-seed-11` is schema 1 and carries neither
        // `expectedDisposition` nor `goldCompleteness`, so the metrics the
        // 2026-08-25 amendment added cannot be computed against it. A run
        // would still print numbers -- the old contract's, wearing the new
        // contract's names.
        [
            {
                registerEntry: budgeted,
                hasApiKey: true,
                datasetFrozen: true,
                commitKnown: true,
                datasetSchemaVersion: 1,
            },
            "legacy_dataset_schema",
        ],
    ];
    for (const [input, reason] of cases) {
        const decision = decideEvalRunMode({
            live: true,
            // Schema 2 unless the row is about the schema: every other row
            // has to reach its own gate rather than stopping at this one.
            datasetSchemaVersion: 2,
            ...input,
        });
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
        commitKnown: true,
        datasetSchemaVersion: 2,
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
        commitKnown: true,
        datasetSchemaVersion: 2,
        requestedRunCapUsd: 5,
    });
    assert.equal(narrowed.mode, "live");
    assert.equal(narrowed.ceilingUsd, 5, "the tighter of the two wins");

    const widened = decideEvalRunMode({
        live: true,
        registerEntry: budgeted,
        hasApiKey: true,
        datasetFrozen: true,
        commitKnown: true,
        datasetSchemaVersion: 2,
        requestedRunCapUsd: 500,
    });
    assert.equal(widened.mode, "refused");
    assert.equal(widened.reason, "run_cap_above_approved_ceiling");
});

/* ------------------------------------------------------- shipped register -- */

test("only a funded, open pair can run live, and it is named", () => {
    // The state after the US$1 probe budget was approved on 2026-08-26. This
    // used to assert that NOTHING could run — which was true, and stopped
    // being true the moment a person funded a pair. A test that asserts the
    // absence of an approval fails on the day the approval arrives, and the
    // honest thing to check is that the funding reaches exactly one pair and
    // that everything else still refuses for its own reason.
    assert.equal(
        MEMORY_EVAL_DATASET_FROZEN,
        true,
        "this test describes the frozen dataset that shipped"
    );

    const runnable = [];
    for (const entry of MEMORY_EXTRACTION_EVAL_REGISTER) {
        const label = `${entry.extractionModelId}::${entry.promptVersion}`;
        const decision = decideEvalRunMode({
            live: true,
            registerEntry: entry,
            hasApiKey: true,
            datasetFrozen: MEMORY_EVAL_DATASET_FROZEN,
            commitKnown: true,
            // The frozen set is schema 1, so a decision-grade run against it
            // is refused whatever the register says. Passing schema 2 here
            // isolates the register's own contribution, which is what this
            // test is about.
            datasetSchemaVersion: 2,
        });
        if (decision.mode === "live") {
            runnable.push(label);
            continue;
        }
        assert.equal(
            decision.reason,
            entry.status === "revoked" ? "pair_not_runnable" : "no_eval_budget",
            label
        );
    }

    // Named, not counted. A second funded pair has to be argued for.
    assert.deepEqual(runnable, ["gpt-5-6-luna::mem-extract-v4"]);
    const funded = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (entry) =>
            `${entry.extractionModelId}::${entry.promptVersion}` === runnable[0]
    );
    assert.equal(funded.status, "candidate");
    assert.ok(funded.evalBudget, "the runnable pair is the funded one");
    // Decision-grade, raised from the probe's US$1 on 2026-08-26. Pinned
    // rather than range-checked: a budget that drifts upward without this
    // line moving is a budget nobody approved for the figure it became.
    assert.equal(funded.evalBudget.maxUsd, 15);

    assert.ok(
        MEMORY_EXTRACTION_EVAL_REGISTER.some(
            (entry) => entry.status === "revoked" && entry.evalBudget
        ),
        "a closed pair keeping its budget is what makes the status check load-bearing"
    );
});

test("the funded pair still cannot run the decision-grade dataset", () => {
    // The second lock, and the reason the budget above is safe to hold. The
    // shipped dataset is schema 1; the amended metrics cannot be computed
    // against it, so the run is refused before it spends whatever the
    // register says.
    const funded = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (entry) =>
            entry.extractionModelId === "gpt-5-6-luna" &&
            entry.promptVersion === "mem-extract-v4"
    );
    assert.ok(funded);
    assert.deepEqual(
        decideEvalRunMode({
            live: true,
            registerEntry: funded,
            hasApiKey: true,
            datasetFrozen: MEMORY_EVAL_DATASET_FROZEN,
            commitKnown: true,
            datasetSchemaVersion: 1,
        }),
        { mode: "refused", reason: "legacy_dataset_schema" }
    );
});

test("a revoked pair is refused even though it still has a budget", () => {
    // The specific hole this closes. `mem-extract-v1` carries an approved
    // US$20 and always will: deleting it would erase that the approval
    // happened and that money was spent against it. A runner that read only
    // `evalBudget` would spend the rest of it on a pair the register closed.
    const revoked = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (entry) => entry.status === "revoked" && entry.evalBudget
    );
    assert.ok(revoked, "expected a revoked entry that kept its budget");
    const decision = decideEvalRunMode({
        live: true,
        registerEntry: revoked,
        hasApiKey: true,
        datasetFrozen: true,
        commitKnown: true,
    });
    assert.equal(decision.mode, "refused");
    assert.equal(decision.reason, "pair_not_runnable");
});

test("a budget opens the budget gate and nothing else", () => {
    // What approving a budget buys, stated exactly, against a table rather
    // than against the shipped register -- which currently has no funded
    // candidate, and should not need one for this contract to be checked.
    const candidate = { status: "candidate", evalBudget: { maxUsd: 50 } };
    const unfunded = { status: "candidate", evalBudget: null };

    assert.equal(
        decideEvalRunMode({
            live: true,
            registerEntry: candidate,
            hasApiKey: true,
            datasetFrozen: true,
            commitKnown: true,
            datasetSchemaVersion: 2,
        }).mode,
        "live"
    );
    // Every other gate still closes on the funded pair. An approval that
    // quietly relaxed a second rule would be an approval nobody gave.
    for (const [name, override] of [
        ["no key", { hasApiKey: false }],
        ["unfrozen dataset", { datasetFrozen: false }],
        ["unknown commit", { commitKnown: false }],
        ["legacy dataset schema", { datasetSchemaVersion: 1 }],
    ]) {
        assert.equal(
            decideEvalRunMode({
                live: true,
                registerEntry: candidate,
                hasApiKey: true,
                datasetFrozen: true,
                commitKnown: true,
                datasetSchemaVersion: 2,
                ...override,
            }).mode,
            "refused",
            `a budget must not open ${name}`
        );
    }
    assert.equal(
        decideEvalRunMode({
            live: true,
            registerEntry: unfunded,
            hasApiKey: true,
            datasetFrozen: true,
            commitKnown: true,
        }).reason,
        "no_eval_budget"
    );
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

test("--live with a key never reaches the network for an unfunded pair", () => {
    // The backup pair is a candidate with no budget, so the harness stops at
    // the budget gate. Asserting the message the run actually reaches is the
    // point: a test that passes by describing the wrong gate is worse than
    // one that fails.
    //
    // **This test supplies a key on purpose, so its safety is the pair being
    // unfunded.** Funding gpt-5-4-mini would turn it into a real
    // decision-grade run against a 1,150-case dataset, stopped only by the
    // network guard — and a guard is not a budget. So the premise is asserted
    // rather than assumed: fund that pair and this fails here, loudly, before
    // it can fail expensively.
    const backup = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (entry) =>
            entry.extractionModelId === "gpt-5-4-mini" &&
            entry.promptVersion === "mem-extract-v4"
    );
    assert.ok(backup, "the backup pair this test relies on is gone");
    assert.equal(
        backup.evalBudget,
        null,
        "gpt-5-4-mini::mem-extract-v4 is funded — this test now spends money"
    );

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

test("the shipped pair refuses without a key, and reaches no network", () => {
    // Recording a budget opens `--live`; it does not open the run. Two gates
    // used to stand after the budget check and the dataset freeze took one of
    // them away, so this test now exercises the one that is left. The
    // guarantee it protects is unchanged and is the reason it exists: funding
    // alone must never be the thing that lets a call out.
    const result = runHarness(["--live", "--model=gpt-5-6-luna"], {
        OPENAI_API_KEY: "",
    });
    assert.equal(result.status, 1, "the run must refuse");
    assert.doesNotMatch(result.output, /is not frozen/i);
    // Which gate stops it depends on what the register says today: with every
    // pair revoked it is the status, and with a candidate registered it would
    // be the key. Any refusal is correct; reaching the network is not, and
    // that is what this test exists for.
    assert.match(
        result.output,
        /OPENAI_API_KEY|no approved eval budget|in the\s+register/i
    );
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

test("a development purpose waives the freeze gate and nothing else", () => {
    // The one relaxation, and the assertion that it is only one. A
    // development probe runs against a sample that is still moving — that is
    // what it is for — but every other gate has to keep closing, or
    // "development" becomes a way round the approval.
    const funded = { status: "candidate", evalBudget: { maxUsd: 5 } };
    const base = {
        live: true,
        registerEntry: funded,
        hasApiKey: true,
        datasetFrozen: false,
        commitKnown: true,
        datasetSchemaVersion: 2,
        datasetPurpose: "development",
    };

    assert.deepEqual(decideEvalRunMode(base), { mode: "live", ceilingUsd: 5 });
    // Same input without the purpose: refused for the freeze.
    assert.deepEqual(
        decideEvalRunMode({ ...base, datasetPurpose: undefined }),
        { mode: "refused", reason: "dataset_not_frozen" }
    );

    for (const [name, override, reason] of [
        ["no pair", { registerEntry: null }, "unknown_pair"],
        [
            "closed pair",
            { registerEntry: { status: "revoked", evalBudget: { maxUsd: 5 } } },
            "pair_not_runnable",
        ],
        [
            "no budget",
            { registerEntry: { status: "candidate", evalBudget: null } },
            "no_eval_budget",
        ],
        ["no key", { hasApiKey: false }, "no_api_key"],
        ["schema 1", { datasetSchemaVersion: 1 }, "legacy_dataset_schema"],
        ["unknown commit", { commitKnown: false }, "unknown_commit"],
        [
            "cap above the approval",
            { requestedRunCapUsd: 50 },
            "run_cap_above_approved_ceiling",
        ],
    ]) {
        assert.deepEqual(
            decideEvalRunMode({ ...base, ...override }),
            { mode: "refused", reason },
            name
        );
    }
});
