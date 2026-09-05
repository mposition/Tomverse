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
