// The AMUX Decision Maker launcher's process half, stage S2-3a
// (docs/policy/amux-decision-maker.md policy version 2, §5 and §5a), with a
// stand-in CLI: a Node script the launcher starts exactly as it would start
// codex or claude. No real CLI runs and nothing is sent anywhere.
//
// §12's blocking criteria this file holds: the launcher refuses a forbidden
// flag and a non-fixed environment before anything starts; no DM process
// starts without the recorded transmission intent; the request's directories
// and the account's CLI state are deleted on every exit path, and a deletion
// that cannot be verified is reported as cleanup_unknown (the app's latch
// acts on it).
//
// A refusal starts nothing, so those tests run everywhere. Starting a process
// group and killing it needs POSIX.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { dmExecutionPlan } from "../lib/amux/decisionMakerLauncherCore.ts";
import { DM_LAUNCH_HARD_TIMEOUT_MS, launchDecisionMaker } from "../lib/amux/decisionMakerLauncherProcess.ts";
import { PAYLOAD, fakeCli, makeLauncherFixture } from "./support/amuxDmLauncherFixture.mjs";

const OPENAI = "decision-maker-openai";
const ANTHROPIC = "decision-maker-anthropic";
const posix = process.platform !== "win32";
const canChmod = posix && process.getuid?.() !== 0;

const select = { kind: "select", optionId: "b", rationale: "Smaller change.", irreversible: false };

/** Records what the launcher gave it, then does `body`. */
const recording = (body) => `
touch("/observed/started", "1");
fs.writeFileSync(at("/observed/argv.json"), JSON.stringify(argv));
fs.writeFileSync(at("/observed/env.json"), JSON.stringify(process.env));
fs.writeFileSync(at("/observed/cwd"), process.cwd());
fs.writeFileSync(at("/observed/stdin"), fs.readFileSync(0));
${body}`;

const CODEX_STATE = `
touch(process.env.HOME + "/.codex/state_5.sqlite", "db");
touch(process.env.HOME + "/.codex/tmp/arg0/codex-arg0abc/.lock", "");
touch(process.env.HOME + "/.codex/models_cache.json", "{}");`;

const CLAUDE_STATE = `
touch(process.env.HOME + "/.claude.json", "{}");
touch(process.env.HOME + "/.claude/sessions/991114.json", "{}");
touch(process.env.HOME + "/.cache/claude/model-catalog/x.json", "{}");
touch(process.env.HOME + "/.local/state/claude/locks/2.1.296.lock", "");`;

const writeOutput = (value) => `touch(argv[argv.indexOf("-o") + 1], ${JSON.stringify(JSON.stringify(value))});`;
const events = (...list) => `process.stdout.write(${JSON.stringify(list.map((event) => JSON.stringify(event)).join("\n") + "\n")});`;
const claudeResult = (overrides = {}) =>
  `process.stdout.write(${JSON.stringify(
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ignored", structured_output: { output: select }, ...overrides }),
  )});`;

const run = async (instance, body, { input = {}, options = {}, mode } = {}) => {
  const fixture = makeLauncherFixture(instance, { executable: (root) => fakeCli(root, body), executableMode: mode });
  try {
    const report = await launchDecisionMaker(fixture.input(input), {
      host: fixture.host,
      expectedExecutableSha256: fixture.executableSha256,
      timeoutMs: 20_000,
      ...options,
    });
    // Read before dispose() removes the fixture.
    const files = Object.fromEntries(
      ["started", "argv.json", "env.json", "cwd", "stdin", "grandchild.pid", "self.pid"].map((name) => {
        const path = fixture.at(`/observed/${name}`);
        return [name, existsSync(path) ? readFileSync(path) : null];
      }),
    );
    const observed = (name) => {
      assert.ok(Object.hasOwn(files, name), name);
      return files[name];
    };
    const pidOf = (name) => {
      const pid = Number(observed(name));
      assert.ok(Number.isSafeInteger(pid) && pid > 1, `${name} holds a process id`);
      return pid;
    };
    return {
      report,
      fixture,
      observed,
      pidOf,
      started: observed("started") !== null,
      home: fixture.homeEntries().sort(),
      requestGone: !existsSync(fixture.at(fixture.paths.requestDirectory)),
      temporaryGone: !existsSync(fixture.at(fixture.paths.temporaryDirectory)),
    };
  } finally {
    fixture.dispose();
  }
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const settle = async (pid) => {
  for (let index = 0; index < 40 && alive(pid); index += 1) await new Promise((done) => setTimeout(done, 50));
  return alive(pid);
};

// ---------------------------------------------------------------------------
// Refusals: nothing starts
// ---------------------------------------------------------------------------

test("§10: without the recorded transmission intent no DM process starts, and cleanup still runs", async () => {
  for (const evidence of [undefined, null, { recorded: true }]) {
    const result = await run(OPENAI, recording(""), { input: { evidence } });
    assert.deepEqual(result.report.result, { outcome: "refused", refusals: ["transmit_intent_missing"] });
    assert.equal(result.started, false);
    assert.deepEqual(result.report.cleanup, { status: "verified" });
    assert.equal(result.requestGone && result.temporaryGone, true);
  }
});

test("§2-4: bytes other than the ones the intent recorded are not sent", async () => {
  const result = await run(ANTHROPIC, recording(""), { input: { payload: Buffer.concat([PAYLOAD, Buffer.from("+")]) } });
  assert.deepEqual(result.report.result, { outcome: "refused", refusals: ["transmit_intent_mismatch"] });
  assert.equal(result.started, false);
});

test("§5a: an executable that is not the policy's sha256 does not start", async () => {
  // No expected-sha256 override: the policy's value, which the stand-in is not.
  const result = await run(OPENAI, recording(""), { options: { expectedExecutableSha256: undefined } });
  assert.deepEqual(result.report.result, { outcome: "refused", refusals: ["executable_sha256_mismatch"] });
  assert.equal(result.started, false);
});

test("§5a: state an earlier request left refuses the start; this request's cleanup then removes it", async () => {
  const fixture = makeLauncherFixture(OPENAI, { executable: (root) => fakeCli(root, recording("")) });
  try {
    fixture.write("/home/amux-dm-openai/.codex/state_5.sqlite", "left over");
    const report = await launchDecisionMaker(fixture.input(), { host: fixture.host, expectedExecutableSha256: fixture.executableSha256 });
    assert.deepEqual(report.result, { outcome: "refused", refusals: ["cli_state_residue"] });
    assert.equal(existsSync(fixture.at("/observed/started")), false);
    assert.deepEqual(report.cleanup, { status: "verified" });
    assert.deepEqual(fixture.homeEntries().sort(), [".codex/", ".codex/auth.json"]);
  } finally {
    fixture.dispose();
  }
});

test("an unknown instance or unusable paths start nothing and cannot be verified clean", async () => {
  const unknown = await launchDecisionMaker({ instance: "decision-maker-gemini", paths: {}, evidence: null, requestKey: null, payload: PAYLOAD });
  assert.deepEqual(unknown, {
    result: { outcome: "refused", refusals: ["instance_unknown"] },
    cleanup: { status: "cleanup_unknown", residue: [{ kind: "instance_unknown", path: "" }] },
  });
  const fixture = makeLauncherFixture(ANTHROPIC);
  try {
    const report = await launchDecisionMaker(fixture.input({ paths: { ...fixture.paths, requestDirectory: "../escape" } }), {
      host: fixture.host,
    });
    assert.deepEqual(report.result, { outcome: "refused", refusals: ["request_paths_invalid"] });
    assert.equal(report.cleanup.status, "cleanup_unknown");
  } finally {
    fixture.dispose();
  }
});

test("on the system host the hard timeout and the executable sha256 are §5a's, not the caller's", async () => {
  assert.equal(DM_LAUNCH_HARD_TIMEOUT_MS, 30 * 60 * 1000);
  // Both are refused before the launcher reads or deletes anything on the real host.
  const input = { instance: OPENAI, paths: {}, evidence: null, requestKey: null, payload: PAYLOAD };
  await assert.rejects(launchDecisionMaker(input, { timeoutMs: 1_000 }), /fixed on the system host/);
  await assert.rejects(launchDecisionMaker(input, { expectedExecutableSha256: "00".repeat(32) }), /fixed on the system host/);
});

// ---------------------------------------------------------------------------
// Started: the result, the timeout, cleanup on every path
// ---------------------------------------------------------------------------

test("codex: the planned command runs with the fixed environment and the question on stdin; -o is the result", { skip: !posix }, async () => {
  const result = await run(OPENAI, recording(`${CODEX_STATE}\n${writeOutput({ output: select })}\n${events({ type: "thread.started" }, { type: "turn.completed" })}`));
  assert.deepEqual(result.report, { result: { outcome: "output", raw: JSON.stringify(select) }, cleanup: { status: "verified" } });
  const planned = dmExecutionPlan(OPENAI, result.fixture.paths);
  assert.deepEqual(JSON.parse(result.observed("argv.json")), planned.plan.argv.slice(1));
  assert.deepEqual(JSON.parse(result.observed("env.json")), {
    HOME: "/home/amux-dm-openai",
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  });
  assert.deepEqual(result.observed("stdin"), PAYLOAD);
  assert.equal(result.observed("cwd").toString().endsWith("/var/lib/amux-dm/requests/r1"), true);
  assert.deepEqual(result.home, [".codex/", ".codex/auth.json"]);
  assert.equal(result.requestGone && result.temporaryGone, true);
});

test("claude: structured_output is the result; the account's state is gone afterwards", { skip: !posix }, async () => {
  const result = await run(ANTHROPIC, recording(`${CLAUDE_STATE}\n${claudeResult()}`));
  assert.deepEqual(result.report, { result: { outcome: "output", raw: JSON.stringify(select) }, cleanup: { status: "verified" } });
  assert.deepEqual(JSON.parse(result.observed("argv.json")), dmExecutionPlan(ANTHROPIC, result.fixture.paths).plan.argv.slice(1));
  // §5a: claude's working directory is the request directory.
  assert.equal(result.observed("cwd").toString().endsWith("/var/lib/amux-dm/requests/r1"), true);
  assert.deepEqual(result.home, [".cache/", ".claude/", ".claude/.credentials.json", ".local/", ".local/state/"]);
});

test("§5a failure signals are no result, and cleanup runs after each", { skip: !posix }, async () => {
  const cases = [
    [OPENAI, `${CODEX_STATE}\n${events({ type: "turn.started" }, { type: "turn.failed", error: { message: "x" } })}\nprocess.exitCode = 1;`, "exit_code_1"],
    [OPENAI, `${writeOutput({ output: select })}\n${events({ type: "turn.failed" })}`, "turn_failed"],
    [OPENAI, events({ type: "turn.completed" }), "result_missing"],
    [OPENAI, `${writeOutput({ output: select })}\nprocess.exitCode = 3;`, "exit_code_other"],
    [ANTHROPIC, `${CLAUDE_STATE}\n${claudeResult({ is_error: true, terminal_reason: "api_error" })}\nprocess.exitCode = 1;`, "exit_code_1"],
    [ANTHROPIC, claudeResult({ is_error: true }), "is_error"],
    [ANTHROPIC, "process.kill(process.pid, 'SIGTERM');", "signal"],
  ];
  for (const [instance, body, reason] of cases) {
    const result = await run(instance, recording(body));
    assert.deepEqual(result.report, { result: { outcome: "unavailable", reason }, cleanup: { status: "verified" } }, reason);
    assert.equal(result.requestGone && result.temporaryGone, true);
  }
});

test("codex: an -o that links to another file is never read", { skip: !posix }, async () => {
  const body = `fs.symlinkSync(at(process.env.HOME + "/.codex/auth.json"), at(argv[argv.indexOf("-o") + 1]));`;
  const result = await run(OPENAI, recording(body));
  assert.deepEqual(result.report, { result: { outcome: "unavailable", reason: "result_unreadable" }, cleanup: { status: "verified" } });
});

test("§5: the hard timeout kills the whole process group; it is a timeout and cleanup runs", { skip: !posix }, async () => {
  const body = `${CODEX_STATE}
const { spawn } = require("child_process");
const child = spawn("/bin/sleep", ["60"], { stdio: ["ignore", "inherit", "ignore"] });
touch("/observed/grandchild.pid", String(child.pid));
touch("/observed/self.pid", String(process.pid));
setTimeout(() => {}, 60000);`;
  const started = Date.now();
  const result = await run(OPENAI, recording(body), { options: { timeoutMs: 1_500 } });
  assert.deepEqual(result.report, { result: { outcome: "timeout" }, cleanup: { status: "verified" } });
  assert.ok(Date.now() - started < 15_000);
  assert.equal(await settle(result.pidOf("self.pid")), false);
  assert.equal(await settle(result.pidOf("grandchild.pid")), false);
  assert.deepEqual(result.home, [".codex/", ".codex/auth.json"]);
});

test("nothing of the process group outlives a normal exit, even holding stdout", { skip: !posix }, async () => {
  const body = `${writeOutput({ output: select })}
const { spawn } = require("child_process");
const child = spawn("/bin/sleep", ["60"], { stdio: ["ignore", "inherit", "ignore"] });
touch("/observed/grandchild.pid", String(child.pid));
child.unref();`;
  const result = await run(OPENAI, recording(body));
  assert.deepEqual(result.report, { result: { outcome: "output", raw: JSON.stringify(select) }, cleanup: { status: "verified" } });
  assert.equal(await settle(result.pidOf("grandchild.pid")), false);
});

test("an executable the account cannot run is spawn_failed, and cleanup runs", { skip: !posix }, async () => {
  const result = await run(ANTHROPIC, recording(claudeResult()), { mode: 0o644 });
  assert.deepEqual(result.report, { result: { outcome: "unavailable", reason: "spawn_failed" }, cleanup: { status: "verified" } });
  assert.equal(result.started, false);
  assert.equal(result.requestGone && result.temporaryGone, true);
});

test("§5: state the account cannot delete is cleanup_unknown, reported beside the result", { skip: !canChmod }, async () => {
  const body = `${writeOutput({ output: select })}
touch(process.env.HOME + "/.codex/locked/session.json", "question text could be here");
fs.chmodSync(at(process.env.HOME + "/.codex/locked"), 0o500);`;
  const result = await run(OPENAI, recording(body));
  assert.deepEqual(result.report.result, { outcome: "output", raw: JSON.stringify(select) });
  assert.deepEqual(result.report.cleanup, {
    status: "cleanup_unknown",
    residue: [{ kind: "state_entry_present", path: "/home/amux-dm-openai/.codex/locked" }],
  });
});
