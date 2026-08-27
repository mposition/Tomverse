/**
 * A paid run must not lose what it paid for.
 *
 * scripts/eval-router-quality.mjs wrote its artefact once, at the end, after
 * 630 provider calls. The first real pilot ran for over an hour against a
 * 90-minute job timeout, and a run killed at item 629 would have paid for
 * everything and recorded nothing. The journal is written as the run goes, and
 * --from-journal turns it back into a report -- without which the journal
 * would be data nobody can read, which is the shape of record this harness
 * refuses everywhere else.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SET = "docs/ops/router-evaluation-set/development-v0.json";

const { spawnSync } = await import("node:child_process");
const exec = (args) =>
    spawnSync(
        process.execPath,
        ["--conditions=react-server", "--import", "tsx", "scripts/eval-router-quality.mjs", ...args],
        { cwd: new URL("..", import.meta.url), encoding: "utf8" }
    );

const directory = mkdtempSync(join(tmpdir(), "router-eval-journal-"));

const pair = (index, verdict) => ({
    kind: "pair",
    pair: {
        itemId: `gen-ko-${String(index).padStart(3, "0")}`,
        stratum: "general_question_answering",
        cell: "ko",
        baselineModelId: "gpt-5-6-luna",
        autoModelId: "deepseek-v4-flash",
        autoPosition: index % 2 === 0 ? "first" : "second",
        outcome: { status: "judged", verdict },
    },
    excluded: null,
    accruedCostUsd: index * 0.001,
});

const journalFile = (name, lines) => {
    const path = join(directory, name);
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
    return path;
};

const header = (overrides = {}) => ({
    kind: "header",
    mode: "pilot",
    setPath: SET,
    evaluationSetVersion: "router-eval-development-v0",
    evaluationSetPurpose: "development",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    baselineModelId: "gpt-5-6-luna",
    judgeModelId: "gpt-5-6-luna",
    seed: 20260826,
    ciMethod: "bootstrap_percentile",
    plannedItems: 210,
    startedAt: "2026-08-26T23:46:41.000Z",
    ...overrides,
});

const preRegistered = ["--baseline=gpt-5-6-luna", "--judge=gpt-5-6-luna", "--seed=20260826"];

test("a rebuild reports what the journal holds, and says it is partial", () => {
    const path = journalFile("partial.jsonl", [
        header(),
        pair(1, "auto"),
        pair(2, "baseline"),
        pair(3, "auto"),
        { kind: "stopped", reason: "sigterm", completedItems: 3 },
    ]);
    const out = join(directory, "rebuilt.json");
    const result = exec([
        "--mode=pilot", `--set=${SET}`, ...preRegistered,
        `--from-journal=${path}`, `--json=${out}`,
    ]);
    assert.match(result.stdout, /Rebuilt from .*partial\.jsonl: 3 of 210 planned item\(s\), stopped by sigterm/);
    assert.match(result.stdout, /PARTIAL — 3 of 210 planned item\(s\)/);

    const record = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(record.plannedItems, 210);
    assert.equal(record.completedItems, 3);
    assert.equal(record.stoppedReason, "sigterm");
    assert.equal(record.rebuiltFromJournal, path);
    assert.equal(record.pairs.length, 3);
    // Carried from the journal, not from the machine doing the rebuild: the
    // commit that ran is the one that spent the money.
    assert.equal(record.commitSha, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(record.startedAt, "2026-08-26T23:46:41.000Z");
});

// A rebuild reaches no provider, so it cannot fill the gap an interrupted run
// left. Silently reporting a complete-looking record would hide that.
test("a complete journal rebuilds without the partial warning", () => {
    const lines = [header({ plannedItems: 4 })];
    for (let index = 1; index <= 4; index += 1) lines.push(pair(index, index % 2 ? "auto" : "baseline"));
    lines.push({ kind: "stopped", reason: "completed", completedItems: 4 });
    const out = join(directory, "complete.json");
    const result = exec([
        "--mode=pilot", `--set=${SET}`, ...preRegistered,
        `--from-journal=${journalFile("complete.jsonl", lines)}`, `--json=${out}`,
    ]);
    assert.doesNotMatch(result.stdout, /PARTIAL/);
    assert.equal(JSON.parse(readFileSync(out, "utf8")).completedItems, 4);
});

test("a journal from a different run is refused", () => {
    const path = journalFile("other.jsonl", [header({ seed: 999 }), pair(1, "auto")]);
    const result = exec(["--mode=pilot", `--set=${SET}`, ...preRegistered, `--from-journal=${path}`]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /was written by a different run/);
});

test("a file that is not a journal is refused", () => {
    const path = journalFile("nothing.jsonl", [pair(1, "auto")]);
    const result = exec(["--mode=pilot", `--set=${SET}`, ...preRegistered, `--from-journal=${path}`]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /has no header line, so it is not a run journal/);
});

// The stopped record is the last thing an interrupted run writes. Without it a
// journal that simply ends is indistinguishable from one that finished.
test("a journal with no stop record says so rather than assuming it finished", () => {
    const path = journalFile("truncated.jsonl", [header(), pair(1, "auto")]);
    const out = join(directory, "truncated.json");
    exec(["--mode=pilot", `--set=${SET}`, ...preRegistered, `--from-journal=${path}`, `--json=${out}`]);
    assert.equal(
        JSON.parse(readFileSync(out, "utf8")).stoppedReason,
        "journal-ends-without-a-stop-record"
    );
});
