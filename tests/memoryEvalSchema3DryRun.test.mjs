/**
 * The schema-3 path, end to end, with the network blocked and no key.
 *
 * ## What this proves that a unit test cannot
 *
 * Every part of the schema-3 work is unit-tested next door, and all of those
 * tests would still pass if the harness had been left scoring the schema-2
 * set with the schema-2 scorer: they exercise the modules, not the wiring.
 * This one runs the actual harness, over the actual dataset, and reads what it
 * wrote — which is the only way to see that the target, the scorer, the two
 * digests and the artifact envelope agree.
 *
 * ## Why it costs nothing
 *
 * Smoke mode. `decideEvalRunMode()` returns `smoke` for any invocation
 * without `--live`, the live adapter's `import("ai")` sits inside a branch
 * only a live decision reaches, and the run executes under the same network
 * blocker the E2E server uses: any non-loopback connection throws instead of
 * dialling out. The assertion that nothing dialled out is therefore about the
 * harness, not about the absence of a key.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveArtifactDataset } from "../lib/memoryEvalDatasetRegistry.ts";
import { harnessTarget } from "../lib/memoryEvalHarnessTarget.ts";
import { MEMORY_EVAL_DATASET_SCHEMA_VERSION } from "../lib/memoryExtractionEvalCore.ts";
import { decideEvalRunMode } from "../lib/memoryExtractionEvalCore.ts";
import { MEMORY_EXTRACTION_EVAL_REGISTER } from "../lib/memoryExtractionEvalRegister.ts";
import { MEMORY_EXTRACTION_PROMPT_VERSION } from "../lib/memoryExtractionPrompt.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HARNESS = "scripts/evalImportedMemoryExtraction.mjs";
const NETWORK_GUARD = fileURLToPath(
    new URL("./e2e/block-external-network.cjs", import.meta.url)
);

const runHarness = (args, env = {}) => {
    try {
        const stdout = execFileSync(
            process.execPath,
            ["--require", NETWORK_GUARD, "--import", "tsx", HARNESS, ...args],
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

test("a smoke run scores the schema-3 set and reaches no provider", () => {
    const directory = mkdtempSync(join(tmpdir(), "mem-eval-schema3-"));
    const artifactPath = join(directory, "artifact.json");
    try {
        const result = runHarness([`--json=${artifactPath}`]);
        assert.equal(result.status, 0, result.output);
        assert.doesNotMatch(
            result.output,
            /QA_EXTERNAL_NETWORK_BLOCKED/,
            "the smoke path attempted an outbound connection"
        );
        // The binding the 2026-08-31 switch was approved to produce, asserted
        // on the harness's own output rather than on the modules it imports:
        // the pair and the dataset have to appear together, because a run
        // that named the new prompt over the old sample would be the failure
        // the switch exists to avoid.
        assert.match(result.output, /gpt-5-6-luna::mem-extract-v7/);
        // "not frozen" is printed, and asserted, because succ-8 is a
        // contract-only successor awaiting its own signature. A smoke run
        // against it is fine — nothing is spent — and the header saying so is
        // what stops a reader from citing its numbers as decision-grade.
        assert.match(result.output, /mem-eval-succ-8 \(decision, not frozen\)/);
        // The manifest digest as well as the sample's: a smoke run names the
        // record its numbers would be resolved against, not only the cases.
        assert.match(
            result.output,
            /manifest: f644c1a3443ff60f….*binding: verified/
        );
        assert.match(result.output, /digest: 9326730a/);
        // succ-5 is an earlier target and must not be what a default run
        // reports; it stays reachable by name, which the harness-target tests
        // cover.
        assert.doesNotMatch(result.output, /mem-eval-succ-5/);
        assert.match(result.output, /SMOKE RUN/);

        const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
        const target = harnessTarget();

        // The envelope says which schema produced the numbers, and it agrees
        // with the target rather than being a constant somebody typed.
        assert.equal(artifact.manifest.datasetSchemaVersion, 3);
        assert.equal(artifact.manifest.datasetVersion, target.datasetVersion);
        assert.equal(artifact.manifest.datasetDigest, target.datasetDigest);
        assert.equal(
            artifact.manifest.scoringContractDigest,
            target.scoringContractDigest
        );

        // A stub that answers each gold correctly must score as correct. If
        // the schema-2 scorer were reading these records every polarity would
        // be ignored and every citation unchecked, and the run would still
        // pass — so the assertion that matters is the one below it.
        assert.equal(artifact.verdict.aggregate.failures, 0);
        // 485 since the target moved to succ-7, whose cases succ-8 inherits by
        // reference. The chain is derivable: succ-5 carried 474; succ-6 lost
        // thirteen cases carrying nothing between them and gained thirteen
        // carrying two (`ko-501`'s expertise gold and `ko-504`'s
        // recurring_context), so 474 − 0 + 2 = 476; succ-7 rewrote sixteen
        // cases whose replacements state facts the originals left implicit,
        // and those carry nine more. 476 + 9.
        //
        // Written out rather than read from the dataset, for the reason the
        // whole file exists: a denominator computed from the same array the
        // scorer walked would agree with itself whatever went wrong.
        //
        // The *numerator* is the amendment's own evidence. Until
        // `mem-score-v3.5` this read 484 against succ-7 — one gold the stub
        // answered verbatim and the scorer marked wrong, because the Korean
        // numeral rule reached inside 토요일 and canonicalised
        // `succ-durable-ko-611`'s token to something no candidate contained.
        // A stub that echoes every gold scoring anything but a perfect
        // recall is a defect in the scorer, and 485 is what says it is fixed.
        assert.equal(artifact.verdict.aggregate.recallNumerator, 485);
        assert.equal(artifact.verdict.aggregate.recallDenominator, 485);
        assert.equal(
            artifact.verdict.aggregate.unboundCandidates,
            0,
            "a citation the stub copied from the gold must resolve"
        );
        // `unboundCandidates` exists only on the schema-3 metrics, so its
        // presence is what says which scorer ran.
        assert.ok(
            Object.hasOwn(artifact.verdict.aggregate, "unboundCandidates"),
            "the schema-2 scorer produced these numbers"
        );

        // And a record carries what schema 3 scores on.
        const scored = artifact.records.find(
            (record) => record.candidates.length > 0
        );
        assert.ok(scored, "no case produced a candidate");
        assert.ok(["affirmed", "negated"].includes(scored.candidates[0].polarity));
        assert.ok(scored.candidates[0].evidence[0].evidenceMessageId);
        assert.ok(scored.candidates[0].evidence[0].evidenceQuote);

        // The artifact this tree writes is one this tree can read back.
        const resolved = resolveArtifactDataset(artifact.manifest);
        assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.detail);
        assert.equal(resolved.manifest.schemaVersion, 3);
        assert.equal(resolved.scoringContract, "verified");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("the gate now admits the schema the harness scores", () => {
    // The block was held until every consumer was converted, and moved on
    // 2026-08-28 once the readiness report showed 0 pending. Asserted rather
    // than left as a comment: whoever moves it again has to say so here.
    assert.equal(MEMORY_EVAL_DATASET_SCHEMA_VERSION, 3);
    const target = harnessTarget();
    assert.equal(target.datasetSchemaVersion, 3);

    // The freeze is stated rather than read, and the line below says why: the
    // gate under test is the *schema* one, which sits past the freeze, and the
    // live target is a contract-only successor nobody has signed yet. Reading
    // `target.datasetFrozen` here would make this test assert
    // `dataset_not_frozen` — true, but about a different gate.
    assert.equal(target.datasetFrozen, false);
    const decision = decideEvalRunMode({
        live: true,
        registerEntry: { status: "candidate", evalBudget: { maxUsd: 50 } },
        hasApiKey: true,
        datasetFrozen: true,
        datasetPurpose: target.datasetPurpose,
        datasetSchemaVersion: target.datasetSchemaVersion,
        commitKnown: true,
        // The 2026-08-28 budget binding, satisfied so that this row reaches
        // the gate it is about. A live decision now also requires the budget
        // to name an instrument, that instrument to be this one, and this
        // commit to descend from the approved implementation.
        budgetBindingProblems: [],
        budgetTupleFailures: [],
        runShaDescendsFromApproval: true,
    });
    assert.deepEqual(decision, { mode: "live", ceilingUsd: 50 });
});

test("whatever version the tree ships, its pair cannot run", () => {
    // The property the test below used to carry implicitly by resolving
    // through the shipped version. Kept as its own assertion so a new prompt
    // version cannot arrive runnable: v6 is refused because it was revoked
    // and v7 because it has no budget, and this does not care which — only
    // that the answer is never `live`.
    const target = harnessTarget();
    const pair = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (entry) =>
            entry.extractionModelId === "gpt-5-6-luna" &&
            entry.promptVersion === MEMORY_EXTRACTION_PROMPT_VERSION
    );
    assert.ok(
        pair,
        `no register entry for gpt-5-6-luna::${MEMORY_EXTRACTION_PROMPT_VERSION}`
    );
    const decision = decideEvalRunMode({
        live: true,
        registerEntry: pair,
        hasApiKey: true,
        datasetFrozen: target.datasetFrozen,
        datasetPurpose: target.datasetPurpose,
        datasetSchemaVersion: target.datasetSchemaVersion,
        commitKnown: true,
    });
    assert.notEqual(
        decision.mode,
        "live",
        `gpt-5-6-luna::${MEMORY_EXTRACTION_PROMPT_VERSION} can run — this test now spends money`
    );
});

test("the shipped pair is closed, and the status answers before the budget", () => {
    // The register entry as the tree actually holds it. It was funded on
    // 2026-08-28, ran once on 2026-08-29, missed every floor of
    // docs/policy/external-conversation-import-and-memory.md §12.3 and was
    // revoked the same day
    // (.github/audits/memory-eval-v6-succ5-run1-2026-08-29.md §7).
    //
    // The budget stays on the row — the approval was real and US$0.7094 was
    // really spent — so "funded" and "runnable" are different questions, and
    // the status is the one that answers first. Asserted with every other
    // reason removed rather than absent: a full binding, a key, a frozen
    // dataset and the right ordinal, and it still refuses.
    const target = harnessTarget();
    // Pinned to v6 by name. This assertion is about the pair that ran and was
    // revoked, and that is a fact about `mem-extract-v6` — resolving it
    // through the shipped version made it silently become an assertion about
    // whatever the tree ships, which since 2026-08-31 is v7, a candidate that
    // never ran.
    const pair = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (entry) =>
            entry.extractionModelId === "gpt-5-6-luna" &&
            entry.promptVersion === "mem-extract-v6"
    );
    assert.ok(pair, "the revoked v6 pair is not registered");
    assert.equal(pair.status, "revoked");
    assert.ok(pair.evalBudget, "the spent budget was dropped rather than kept");

    const base = {
        live: true,
        registerEntry: pair,
        hasApiKey: true,
        datasetFrozen: target.datasetFrozen,
        datasetPurpose: target.datasetPurpose,
        datasetSchemaVersion: target.datasetSchemaVersion,
        commitKnown: true,
    };
    assert.deepEqual(
        decideEvalRunMode({
            ...base,
            budgetBindingProblems: [],
            budgetTupleFailures: [],
            runShaDescendsFromApproval: true,
            runOrdinal: 1,
        }),
        { mode: "refused", reason: "pair_not_runnable" }
    );
    // And ordinal 2 — the reproducibility run that was not approved — is
    // refused for the status too, not for the ordinal.
    assert.equal(
        decideEvalRunMode({
            ...base,
            budgetBindingProblems: [],
            budgetTupleFailures: [],
            runShaDescendsFromApproval: true,
            runOrdinal: 2,
        }).reason,
        "pair_not_runnable"
    );
});

test("the binding still decides a pair the register leaves open", () => {
    // The claim the schema-3 transition was about, kept alive against a
    // synthetic open entry now that the real one is closed: past the schema
    // gate, what stands between a funded pair and a provider is the binding —
    // the instrument the budget names, and the commit the run descends from.
    //
    // Asserted as the *difference* three inputs make, because that is the
    // claim: the schema is no longer the answer, and the binding is.
    const target = harnessTarget();
    // Same stated premise as the schema test above, for the same reason: the
    // binding gates sit past the freeze, and succ-8 is unsigned.
    assert.equal(target.datasetFrozen, false);
    const base = {
        live: true,
        registerEntry: {
            status: "candidate",
            evalBudget: { maxUsd: 6.285, maxProviderDispatchedRuns: 2 },
        },
        hasApiKey: true,
        datasetFrozen: true,
        datasetPurpose: target.datasetPurpose,
        datasetSchemaVersion: target.datasetSchemaVersion,
        commitKnown: true,
    };
    assert.deepEqual(decideEvalRunMode(base), {
        mode: "refused",
        reason: "run_sha_not_descendant",
    });
    assert.deepEqual(
        decideEvalRunMode({
            ...base,
            budgetTupleFailures: ["datasetDigest: approved x, this run would use y"],
            runShaDescendsFromApproval: true,
        }),
        { mode: "refused", reason: "budget_tuple_mismatch" }
    );
    assert.deepEqual(
        decideEvalRunMode({
            ...base,
            budgetBindingProblems: [],
            budgetTupleFailures: [],
            runShaDescendsFromApproval: true,
            // Which of the two approved runs this would be. A budget that
            // names a run count refuses an invocation that does not say — the
            // ceiling is per-run and nothing here can count what earlier runs
            // spent.
            runOrdinal: 1,
        }),
        { mode: "live", ceilingUsd: 6.285 }
    );
});

test("no test invokes --live on the funded pair", () => {
    // **This file must never run the harness with `--live` and a key.**
    //
    // It used to, safely: `gpt-5-6-luna::mem-extract-v6` had no budget, so the
    // harness refused before reaching an adapter and the invocation proved
    // that nothing dialled out. The 2026-08-28 budget made that premise false
    // — the same command now passes every gate and dispatches — and a test
    // that spends money to assert it does not is the worst possible shape.
    //
    // The guarantee those invocations protected is covered without them: the
    // smoke run above exercises the whole path with the network blocked, and
    // `tests/memoryEvalBudgetBinding.test.mjs` decides the live gate as a pure
    // truth table. What is left here is the rule itself, asserted against this
    // file's own source so it cannot be undone by editing the file.
    const source = readFileSync(
        fileURLToPath(new URL("./memoryEvalSchema3DryRun.test.mjs", import.meta.url)),
        "utf8"
    );
    // The needle is assembled rather than written, so the line performing the
    // check is not itself a match.
    const needle = `runHarness([${JSON.stringify("--live")}`;
    const liveInvocations = source
        .split("\n")
        .filter((line) => line.includes(needle));
    assert.deepEqual(liveInvocations, []);
});
