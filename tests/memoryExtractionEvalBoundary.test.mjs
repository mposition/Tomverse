import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MEMORY_EXTRACTION_EVAL_REGISTER } from "../lib/memoryExtractionEvalRegister.ts";
import { findApprovedEvalPair } from "../lib/memoryExtractionEvalRegister.ts";
import {
    MEMORY_EVAL_DATASET_SCHEMA_VERSION,
    decideEvalRunMode,
} from "../lib/memoryExtractionEvalCore.ts";
import { MEMORY_EXTRACTION_PROMPT_VERSION } from "../lib/memoryExtractionPrompt.ts";
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
import { MEMORY_EVAL_SUCC3_DATASET_FROZEN } from "../lib/memoryEvalSucc3Fixtures.ts";

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
            // The gated schema unless the row is about the schema: every other
            // row has to reach its own gate rather than stopping at this one.
            datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
            budgetBindingProblems: [],
            budgetTupleFailures: [],
            runShaDescendsFromApproval: true,
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
        datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
        // "Every precondition" grew three on 2026-08-28: the budget names an
        // instrument, this run assembles it, and this commit descends from the
        // approved implementation.
        budgetBindingProblems: [],
        budgetTupleFailures: [],
        runShaDescendsFromApproval: true,
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
        datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
        budgetBindingProblems: [],
        budgetTupleFailures: [],
        runShaDescendsFromApproval: true,
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
        datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
        budgetBindingProblems: [],
        budgetTupleFailures: [],
        runShaDescendsFromApproval: true,
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
            // is refused whatever the register says. Passing the gated schema
            // here isolates the register's own contribution, which is what
            // this test is about — and the budget binding is satisfied for the
            // same reason.
            datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
            budgetBindingProblems: [],
            budgetTupleFailures: [],
            runShaDescendsFromApproval: true,
            // Likewise the run ordinal: a budget that names a run count wants
            // one, and leaving it out would make every funded entry refuse
            // for the ordinal rather than tell us anything about the register.
            runOrdinal: 1,
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

    // Named, not counted. `mem-extract-v5` was funded on 2026-08-27, ran, and
    // was closed the same day: v5-run1 missed every
    // docs/policy/external-conversation-import-and-memory.md §12.3 floor and the
    // hard-zero gate, so both v5 pairs are `revoked` and refuse for the
    // status ahead of the budget
    // (.github/audits/memory-eval-v5-run1-2026-08-27.md). Its budget stays on
    // the record -- the approval was real and part of it was really spent --
    // which is why "funded" and "runnable" are not the same list.
    assert.deepEqual(runnable, [
        "gpt-5-6-luna::mem-extract-v4",
        "gpt-5-6-luna::mem-extract-v7",
    ]);
    // Pinned rather than range-checked: a budget that drifts upward without
    // these lines moving is a budget nobody approved for the figure it
    // became.
    //
    // v4's US$15 predates instrument binding and, as
    // `tests/memoryEvalV5Budget.test.mjs` shows, that budget cannot fund a run
    // at all — being in this list means the register would allow it, not that
    // the binding would.
    //
    // v7's US$6.39 is the first entry for which both halves hold: it names an
    // instrument, and that instrument matches what the tree assembles. So it
    // is genuinely runnable, and the thing standing between it and a provider
    // is an explicit instruction to run — not another gate
    // (.github/audits/memory-eval-v7-budget-approval-2026-08-31.md section 3).
    const ceilings = {
        "gpt-5-6-luna::mem-extract-v4": 15,
        "gpt-5-6-luna::mem-extract-v7": 6.39,
    };
    for (const label of runnable) {
        const funded = MEMORY_EXTRACTION_EVAL_REGISTER.find(
            (entry) =>
                `${entry.extractionModelId}::${entry.promptVersion}` === label
        );
        assert.equal(funded.status, "candidate", label);
        assert.ok(funded.evalBudget, `${label} is runnable but unfunded`);
        assert.equal(funded.evalBudget.maxUsd, ceilings[label], label);
        assert.ok(funded.evalBudget.ticket, `${label} names no approval record`);
    }
    // v6 is funded and closed, which is the shape this list cannot show. It
    // ran on 2026-08-29, missed every §12.3 floor and was revoked the same
    // day; the budget stays because US$0.7094 of it was really spent
    // (.github/audits/memory-eval-v6-succ5-run1-2026-08-29.md §7). So it is
    // funded, refuses for the status, and its ceiling is asserted here rather
    // than in the runnable map above.
    const closedV6 = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (entry) =>
            entry.extractionModelId === "gpt-5-6-luna" &&
            entry.promptVersion === "mem-extract-v6"
    );
    assert.equal(closedV6.status, "revoked");
    assert.equal(closedV6.evalBudget.maxUsd, 6.285);
    assert.equal(closedV6.evalBudget.programmeMaxMicroUsd, 12_570_000);
    assert.equal(closedV6.evaluation, null);

    // Both backups stay unfunded. A backup that inherited its primary's
    // ceiling would be a funded pair nobody approved.
    for (const version of [
        "mem-extract-v4",
        "mem-extract-v5",
        "mem-extract-v6",
    ]) {
        const backup = MEMORY_EXTRACTION_EVAL_REGISTER.find(
            (entry) =>
                entry.extractionModelId === "gpt-5-4-mini" &&
                entry.promptVersion === version
        );
        assert.equal(backup.evalBudget, null, `${version} backup is funded`);
    }
    // And a funded pair that has been closed keeps its budget while refusing
    // to run -- the two facts the `runnable` list above separates.
    const closed = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (entry) =>
            entry.extractionModelId === "gpt-5-6-luna" &&
            entry.promptVersion === "mem-extract-v5"
    );
    assert.equal(closed.status, "revoked");
    assert.ok(closed.evalBudget, "the closed pair lost the budget it spent");

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
            datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
            budgetBindingProblems: [],
            budgetTupleFailures: [],
            runShaDescendsFromApproval: true,
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
                datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
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

test("--live with a key never reaches the network for a pair that cannot run", () => {
    // **This test supplies a key on purpose, so its safety is the pair being
    // unable to run.** If gpt-5-4-mini's live pair could, this would become a
    // real decision-grade run against 1,150 cases, stopped only by the network
    // guard -- and a guard is not a budget. So the premise is asserted rather
    // than assumed: make that pair runnable and this fails here, loudly,
    // before it can fail expensively.
    //
    // The pair is resolved the way the harness resolves it -- the model from
    // the flag, the prompt version from the tree -- rather than named. Naming
    // `mem-extract-v4` while the tree carried v5 is how this test came to
    // assert one gate's message about a different entry: it passed only while
    // both happened to be unfunded, and broke the day v5 was closed.
    const pair = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (entry) =>
            entry.extractionModelId === "gpt-5-4-mini" &&
            entry.promptVersion === MEMORY_EXTRACTION_PROMPT_VERSION
    );
    // The pair may not exist at all, and since 2026-08-31 it does not: v7 was
    // registered for `gpt-5-6-luna` only. An absent entry is a stronger
    // safety position than an unfundable one — the harness refuses on the
    // register miss, earlier than any budget question — so this asserts the
    // premise rather than the entry: whatever the register holds for this
    // model at the shipped version, it cannot run.
    if (pair) {
        const decision = decideEvalRunMode({
            live: true,
            registerEntry: pair,
            hasApiKey: true,
            datasetFrozen: true,
            datasetPurpose: "decision",
            datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
            commitKnown: true,
        });
        assert.notEqual(
            decision.mode,
            "live",
            `gpt-5-4-mini::${MEMORY_EXTRACTION_PROMPT_VERSION} can run -- this test now spends money`
        );
    }

    const result = runHarness(["--live", "--model=gpt-5-4-mini"], {
        // Plausible enough that a missing-key check could not be what stops it.
        OPENAI_API_KEY: "sk-test-EXAMPLE-not-a-real-key-000000000000",
    });
    assert.equal(result.status, 1, "the run must refuse");
    // Which gate speaks is the register's business and changes with it. What
    // this test owns is that the refusal happened before anything dialled out.
    assert.match(
        result.output,
        /no approved eval budget|in the\s+register|No register entry/i,
        result.output
    );
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
    // The dangerous shape once the floor is met: a stub agreeing with itself
    // prints "Every §12.3 rule passed", and without the caveat beside it that
    // reads like a decision-grade result. The caveat is asserted on its own
    // rather than leaning on the "not frozen" disclaimer beside it, because
    // that disclaimer comes and goes with the current target's freeze state --
    // it was absent while succ-2 was the target and is back while succ-3 is
    // being authored. A caveat that only appears for an unfrozen dataset is
    // exactly the wrong way round.
    const result = runHarness([]);
    assert.match(result.output, /SMOKE RUN — NOT an eval result/);
    assert.match(result.output, /No provider was called/);
    assert.match(
        result.output,
        MEMORY_EVAL_SUCC3_DATASET_FROZEN
            ? /\(decision, frozen\)/
            : /\(decision, not frozen\)/
    );
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
        datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
        datasetPurpose: "development",
        // The 2026-08-28 budget binding, satisfied so that this row reaches
        // the gate it is about. A live decision now also requires the budget
        // to name an instrument, that instrument to be this one, and this
        // commit to descend from the approved implementation.
        budgetBindingProblems: [],
        budgetTupleFailures: [],
        runShaDescendsFromApproval: true,
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
