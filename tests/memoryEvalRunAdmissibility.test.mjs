/**
 * The pre-registered admissibility rules, as a truth table.
 *
 * docs/policy/external-conversation-import-and-memory.md §12.2 requires these
 * rules to be fixed before the run. Fixed in prose and re-read afterwards they
 * drift, because the verdict is on screen by then -- so they live in
 * scripts/check-memory-eval-run-admissibility.mjs and their shape is pinned
 * here. The confirmed text is
 * docs/ops/memory-extraction-decision-grade-run.md §3.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url);

const ADMISSIBLE = {
    modelId: "gpt-5-6-luna",
    promptVersion: "mem-extract-v1",
    datasetVersion: "mem-eval-seed-11",
    commitSha: "0".repeat(40),
    workingTreeDirty: false,
    truncatedByCostCeiling: false,
    exceededCostCeiling: false,
    // A live artifact needs comparable figures too: without them the run is
    // discarded as `spendComparableToCeiling`, which is its own rule.
    mode: "live",
    accruedCostUsd: 4.2,
    runCeilingUsd: 7,
    abortedOnConsecutiveFailures: false,
    decisionGrade: true,
    spendCeilingReliable: true,
};

const check = (manifest) => {
    const dir = mkdtempSync(join(tmpdir(), "run-admissibility-"));
    const path = join(dir, "artifact.json");
    writeFileSync(path, JSON.stringify({ manifest }), "utf8");
    return spawnSync(
        process.execPath,
        ["scripts/check-memory-eval-run-admissibility.mjs", `--artifact=${path}`],
        { cwd: ROOT, encoding: "utf8" }
    );
};

test("a clean run is admissible", () => {
    const result = check(ADMISSIBLE);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /Admissible/);
});

test("a live run whose spend cannot be compared is discarded, not passed", () => {
    // Its own test rather than a row in the loop below, because the loop
    // asserts the failing rule is named after the field it set — and here the
    // field that is missing (`accruedCostUsd`) is not the rule that fires
    // (`spendComparableToCeiling`). That mismatch is the point of the rule:
    // the artifact's defect is an absence, so nothing in it can be named.
    //
    // Every one of these used to print `OK exceededCostCeiling` and exit 0,
    // because the rule read the verdict and not the source behind it.
    // Without the flag, which is the shape a real artifact from before
    // 2026-09-05 has. A `false` flag is an answer even with nothing to compare
    // — the harness wrote it — and that case is asserted admissible below.
    const noFlag = { ...ADMISSIBLE };
    delete noFlag.exceededCostCeiling;
    for (const manifest of [
        { ...noFlag, accruedCostUsd: undefined, runCeilingUsd: undefined },
        { ...noFlag, accruedCostUsd: null },
        { ...noFlag, runCeilingUsd: "7" },
        { ...noFlag, accruedCostUsd: "4.2" },
    ]) {
        const result = check(manifest);
        assert.equal(result.status, 1, result.stdout);
        assert.match(result.stdout, /Not admissible:.*spendComparableToCeiling/);
    }
    // A smoke run has no ceiling to compare against, and is not caught by it.
    const smoke = check({
        ...noFlag,
        mode: "smoke",
        accruedCostUsd: undefined,
        runCeilingUsd: undefined,
    });
    assert.equal(smoke.status, 0, smoke.stdout);
    // And a live run whose harness wrote `exceededCostCeiling: false` is
    // answered by that, figures or no figures.
    const flagged = check({
        ...ADMISSIBLE,
        accruedCostUsd: undefined,
        runCeilingUsd: undefined,
    });
    assert.equal(flagged.status, 0, flagged.stdout);
});

test("each discarding signal discards on its own", () => {
    for (const [field, value] of [
        ["workingTreeDirty", true],
        ["truncatedByCostCeiling", true],
        // Added after an artifact carrying this and `decisionGrade: true` was
        // fed to the checker by hand and came back Admissible with exit 0.
        // Producing one is now impossible from the harness; reading one was
        // not, and old artifacts predate the field entirely.
        ["exceededCostCeiling", true],
        ["abortedOnConsecutiveFailures", true],
        ["decisionGrade", false],
        ["commitSha", "unknown"],
        ["commitSha", ""],
    ]) {
        const result = check({ ...ADMISSIBLE, [field]: value });
        assert.equal(result.status, 1, `${field} should discard the run`);
        assert.match(result.stdout, new RegExp(`Not admissible:.*${field}`));
    }
});

test("an unpriced call is a cost note, not a discard", () => {
    // The one asymmetry in the pre-registration, and the reason it is written
    // down: failing to read a price and the model being wrong are different
    // facts. Folding them together throws away a sound run, or lets an
    // unbounded one pass as bounded.
    const result = check({ ...ADMISSIBLE, spendCeilingReliable: false });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /NOTE {2}spendCeilingReliable/);
    assert.match(result.stdout, /invoice/);
});

test("a run that cannot name its commit is discarded", () => {
    // The failure that motivated the rule: run from a deployed container,
    // `git rev-parse` returns nothing, so the harness writes commit "unknown"
    // and -- because the same call fails -- `workingTreeDirty: false`. The
    // artifact reads as a spotless checkout. The harness refuses this case up
    // front now; the rule stays for artifacts written before it did.
    const result = check({ ...ADMISSIBLE, commitSha: "unknown", workingTreeDirty: false });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /cannot name the commit/);
});

test("a manifest missing a field is discarded, not assumed clean", () => {
    // An artifact from an older harness has no `decisionGrade`. Reading that
    // absence as "fine" is how an unciteable run gets cited.
    const { decisionGrade, ...withoutField } = ADMISSIBLE;
    void decisionGrade;
    const result = check(withoutField);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /decisionGrade/);
});

test("a probe is never admissible", () => {
    // A probe runs the first N cases to check the wiring. Its numbers are a
    // slice of the sample, so `decisionGrade` is false whatever they say, and
    // the pre-registered rules discard it on that alone -- there is no route
    // by which a compatibility check becomes a result.
    const result = check({ ...ADMISSIBLE, decisionGrade: false, probeLimit: 10 });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /decisionGrade/);
});

test("a smoke run is never admissible", () => {
    // Smoke answers come from a deterministic stub, so `decisionGrade` is
    // false and this must never read as a result.
    const result = check({ ...ADMISSIBLE, decisionGrade: false, mode: "smoke" });
    assert.equal(result.status, 1);
});
