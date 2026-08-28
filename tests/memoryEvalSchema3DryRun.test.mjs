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
        assert.match(result.output, /mem-eval-succ-5/);
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
        assert.equal(artifact.verdict.aggregate.recallNumerator, 474);
        assert.equal(artifact.verdict.aggregate.recallDenominator, 474);
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

    const decision = decideEvalRunMode({
        live: true,
        registerEntry: { status: "candidate", evalBudget: { maxUsd: 50 } },
        hasApiKey: true,
        datasetFrozen: target.datasetFrozen,
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

test("the budget binding, not the schema, is what decides the real pair", () => {
    // The register entry as the tree actually holds it. Moving the gate opened
    // the harness and nothing else; the 2026-08-28 budget then funded exactly
    // one pair, and what stands between it and a provider is the binding —
    // the instrument the budget names, and the commit the run descends from.
    //
    // Asserted as the *difference* two inputs make, because that is the claim:
    // the schema is no longer the answer, and the binding is.
    const target = harnessTarget();
    const pair = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (entry) =>
            entry.extractionModelId === "gpt-5-6-luna" &&
            entry.promptVersion === MEMORY_EXTRACTION_PROMPT_VERSION
    );
    assert.ok(pair, "the shipped pair is not registered");
    const base = {
        live: true,
        registerEntry: pair,
        hasApiKey: true,
        datasetFrozen: target.datasetFrozen,
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
        }),
        { mode: "live", ceilingUsd: pair.evalBudget.maxUsd }
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
