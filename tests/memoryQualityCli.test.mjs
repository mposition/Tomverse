import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRunStore, readEvents, requestStop } from "../tools/memory-quality/store.ts";
import { main } from "../tools/memory-quality/cli.ts";

test("CLI smoke is network-blocked, inspectable, and replayable with identical candidate evaluation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-quality-cli-"));
  try {
    const blocker = join(directory, "deny-network.cjs");
    await writeFile(blocker, 'require("node:net").Socket.prototype.connect = function () { throw Error("NETWORK_FORBIDDEN"); }; global.fetch = async () => { throw Error("NETWORK_FORBIDDEN"); };');
    const output = join(directory, "runs");
    const source = execFileSync(process.execPath, ["--require", blocker, "--import", "tsx",
      "tools/memory-quality/cli.ts", "run", "--out", output, "--mode", "mock"], {
      cwd: resolve("."), encoding: "utf8", timeout: 30000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_OPTIONS: "" },
    });
    const first = JSON.parse(source);
    assert.equal(first.recommendation, "human_review_candidate");
    assert.equal(first.paidCalls, 0);
    const list = await main(["list", "--out", output]);
    assert.equal(list.runs[0].id, first.id);
    const show = await main(["show", "--out", output, "--run", first.id]);
    assert.equal(show.candidates.some((candidate) => candidate.type === "candidate_frozen"), true);
    assert.equal(show.evaluations.at(-1).type, "validation_evaluation");
    const replayFile = join(directory, "replay.json");
    await main(["export-replay", "--out", output, "--run", first.id, "--file", replayFile]);
    const replay = await main(["run", "--out", output, "--mode", "replay", "--responses", replayFile]);
    assert.equal(replay.candidateId, first.candidateId);
    assert.equal(replay.recommendation, first.recommendation);
    assert.equal(replay.calls, first.calls);
    const records = await readEvents(first.directory);
    assert.deepEqual(records.map((event) => event.sequence), records.map((_, index) => index + 1));
    assert.equal(JSON.parse(await readFile(join(first.directory, "result.json"), "utf8")).promoted, false);
    await assert.rejects(main(["stop", "--out", output, "--run", first.id]), /run_finished/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("operator stop persists and a closed store refuses further writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-quality-stop-"));
  try {
    const store = await createRunStore(directory);
    assert.equal(await store.stopped(), false);
    await requestStop(directory, store.id);
    assert.equal(await store.stopped(), true);
    await store.record({ type: "finished", stopReason: "operator_stop" });
    await assert.rejects(store.record({ type: "candidate" }), /run_finished/);
    await assert.rejects(requestStop(directory, store.id), /run_finished/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("CLI refuses live flags, invalid limits and directory traversal", async () => {
  for (const args of [["run", "--mode", "live"], ["run", "--live", "true"], ["run", "--model", "paid-model"],
    ["show", "--run", "../outside"]]) {
    await assert.rejects(main(args));
  }
  const directory = await mkdtemp(join(tmpdir(), "memory-quality-invalid-"));
  try {
    const result = await main(["run", "--out", directory, "--max-calls", "-1"]);
    assert.equal(result.stopReason, "invalid_limits");
    assert.equal(result.recommendation, "none");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
