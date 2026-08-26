/**
 * A probe prints the answers, not only the counts.
 *
 * The first probe of `(gpt-5-6-luna, mem-extract-v2)` came back with no
 * failures and nine adoptions against three matched gold labels. The summary
 * could not say whether the other six were wrong, extra-but-correct, or right
 * under a different `kind` -- and those need different responses. Matching
 * requires exact kind equality, so a correct statement filed elsewhere scores
 * identically to a wrong one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const run = (args) =>
    spawnSync(
        process.execPath,
        ["--conditions=react-server", "--import", "tsx", "scripts/evalImportedMemoryExtraction.mjs", ...args],
        { cwd: new URL("..", import.meta.url), encoding: "utf8" }
    ).stdout;

test("a probe prints each case's expectation and what came back", () => {
    const output = run(["--limit=3"]);
    assert.match(output, /What the model returned, case by case/);
    assert.match(output, /expected: \w+ \+ \[/);
    assert.match(output, /\[MATCH\]/);
    // The statements themselves, because a reader deciding whether a label or
    // a model is wrong cannot do it from a verdict word.
    assert.match(output, /bulk-safe (true|false) — /);
});

test("a full run does not print it", () => {
    // 1,150 cases of detail is not a report, and the artifact holds the
    // records for anyone who needs them.
    const output = run([]);
    assert.doesNotMatch(output, /What the model returned, case by case/);
});

test("the kind-versus-tokens distinction is stated, not implied", () => {
    const output = run(["--limit=3"]);
    assert.match(output, /kind differs|kind matches, tokens do not|MATCH/);
    assert.match(output, /counts as\s*\n?a false positive/);
});
