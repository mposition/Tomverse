// The AMUX Decision Maker launcher's process half, stage S2-3a
// (docs/policy/amux-decision-maker.md policy version 2, §5 and §5a), with a
// stand-in CLI: a Node script the launcher starts exactly as it would start
// codex or claude. No real CLI runs and nothing is sent anywhere.
//
// §12's blocking criteria this file holds: the launcher refuses a forbidden
// flag and a non-fixed environment before anything starts; no DM process
// starts without the recorded transmission intent, and what it receives is
// the bytes that intent recorded; the request's directories and the
// account's CLI state are deleted on every exit path (the request directory
// by the broker's call after the launcher returns), and a deletion that
// cannot be verified is reported as cleanup_unknown (the app's latch acts on
// it).
//
// A refusal starts nothing, so those tests run everywhere. Starting a process
// group and killing it needs POSIX.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DM_REQUEST_ROOT, dmExecutionPlan } from "../lib/amux/decisionMakerLauncherCore.ts";
import { dmCleanupRequestDirectory } from "../lib/amux/decisionMakerLauncherFs.ts";
import { DM_LAUNCH_HARD_TIMEOUT_MS, launchDecisionMaker } from "../lib/amux/decisionMakerLauncherProcess.ts";
import { PAYLOAD, REQUEST_ID, fakeCli, makeLauncherFixture } from "./support/amuxDmLauncherFixture.mjs";

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

/**
 * One request as the broker would run it: the launcher, then the broker's own
 * cleanup of the request directory, whatever the launcher returned.
 */
const run = async (instance, body, { input = {}, options = {}, mode, prepare, mutate } = {}) => {
  const fixture = makeLauncherFixture(instance, { executable: (root) => fakeCli(root, body), executableMode: mode });
  try {
    prepare?.(fixture);
    const launchInput = fixture.input(input);
    const pending = launchDecisionMaker(launchInput, {
      host: fixture.host,
      expectedExecutableSha256: fixture.executableSha256,
      timeoutMs: 20_000,
      ...options,
    });
    mutate?.(launchInput);
    const report = await pending;
    const requestCleanup = dmCleanupRequestDirectory(fixture.host, instance, REQUEST_ID);
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
      requestCleanup,
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

const VERIFIED = { status: "verified" };

// ---------------------------------------------------------------------------
// Refusals: nothing starts
// ---------------------------------------------------------------------------

test("§10: without the recorded transmission intent no DM process starts, and both cleanups still run", async () => {
  for (const evidence of [undefined, null, { recorded: true }]) {
    const result = await run(OPENAI, recording(""), { input: { evidence } });
    assert.deepEqual(result.report.result, { outcome: "refused", refusals: ["transmit_intent_missing"] });
    assert.equal(result.started, false);
    assert.deepEqual(result.report.cleanup, VERIFIED);
    assert.deepEqual(result.requestCleanup, VERIFIED);
    assert.equal(result.requestGone && result.temporaryGone, true);
  }
});

test("§2-4: bytes other than the ones the intent recorded are not sent", async () => {
  const result = await run(ANTHROPIC, recording(""), { input: { payload: Buffer.concat([PAYLOAD, Buffer.from("+")]) } });
  assert.deepEqual(result.report.result, { outcome: "refused", refusals: ["transmit_intent_mismatch"] });
  assert.equal(result.started, false);
});

test("§10: an intent recorded for another request does not start this one", async () => {
  const fixture = makeLauncherFixture(OPENAI);
  try {
    const evidence = { ...fixture.evidence, requestId: "0a1b2c3d-4e5f-4a6b-8c7d-000000000001" };
    const report = await launchDecisionMaker(fixture.input({ evidence }), {
      host: fixture.host,
      expectedExecutableSha256: fixture.executableSha256,
    });
    assert.deepEqual(report.result, { outcome: "refused", refusals: ["transmit_intent_mismatch"] });
  } finally {
    fixture.dispose();
  }
});

test("§5a: an executable that is not the policy's sha256 does not start", async () => {
  // No expected-sha256 override: the policy's value, which the stand-in is not.
  const result = await run(OPENAI, recording(""), { options: { expectedExecutableSha256: undefined } });
  assert.deepEqual(result.report.result, { outcome: "refused", refusals: ["executable_sha256_mismatch"] });
  assert.equal(result.started, false);
});

test("§5a: state an earlier request left refuses the start; this request's cleanup then removes it", async () => {
  const result = await run(OPENAI, recording(""), {
    prepare: (fixture) => fixture.write("/home/amux-dm-openai/.codex/state_5.sqlite", "left over"),
  });
  assert.deepEqual(result.report.result, { outcome: "refused", refusals: ["cli_state_residue"] });
  assert.equal(result.started, false);
  assert.deepEqual(result.report.cleanup, VERIFIED);
  assert.deepEqual(result.home, [".codex/", ".codex/auth.json"]);
});

test("an unknown instance or a request id that is not the app's starts nothing", async () => {
  const unknown = await launchDecisionMaker({ instance: "decision-maker-gemini", requestId: REQUEST_ID, evidence: null, requestKey: null, payload: PAYLOAD });
  assert.deepEqual(unknown, {
    result: { outcome: "refused", refusals: ["instance_unknown"] },
    cleanup: { status: "cleanup_unknown", residue: [{ kind: "instance_unknown", path: "" }] },
  });
  const fixture = makeLauncherFixture(ANTHROPIC);
  try {
    for (const requestId of ["../escape", "/var/lib/amux-dm/requests/x", null]) {
      const report = await launchDecisionMaker(fixture.input({ requestId }), { host: fixture.host });
      assert.deepEqual(report.result, { outcome: "refused", refusals: ["request_id_invalid"] });
      // Nothing was made for an id that names no request; the account's state is still checked.
      assert.deepEqual(report.cleanup, VERIFIED);
    }
  } finally {
    fixture.dispose();
  }
});

test("on the system host the hard timeout and the executable sha256 are §5a's, not the caller's", async () => {
  assert.equal(DM_LAUNCH_HARD_TIMEOUT_MS, 30 * 60 * 1000);
  // Both are refused before the launcher reads or deletes anything on the real host.
  const input = { instance: OPENAI, requestId: REQUEST_ID, evidence: null, requestKey: null, payload: PAYLOAD };
  await assert.rejects(launchDecisionMaker(input, { timeoutMs: 1_000 }), /fixed on the system host/);
  await assert.rejects(launchDecisionMaker(input, { expectedExecutableSha256: "00".repeat(32) }), /fixed on the system host/);
});

// ---------------------------------------------------------------------------
// Review r-20261017-022204-8754f3
// ---------------------------------------------------------------------------

test("finding 1: a link on the request root's path deletes nothing outside, on the refusal path and after", { skip: !posix }, async () => {
  const outside = mkdtempSync(join(tmpdir(), "amux-dm-launcher-outside-"));
  try {
    mkdirSync(join(outside, REQUEST_ID));
    writeFileSync(join(outside, REQUEST_ID, "precious"), "not the request's");
    const result = await run(OPENAI, recording(""), {
      // No intent: the refusal path, where cleanup still runs.
      input: { evidence: undefined },
      prepare: (fixture) => {
        rmSync(fixture.at(DM_REQUEST_ROOT), { recursive: true });
        symlinkSync(outside, fixture.at(DM_REQUEST_ROOT));
      },
    });
    assert.deepEqual(result.report.result, {
      outcome: "refused",
      refusals: ["request_directories_unusable", "transmit_intent_missing"],
    });
    assert.deepEqual(result.requestCleanup, {
      status: "cleanup_unknown",
      residue: [{ kind: "path_unsafe", path: DM_REQUEST_ROOT }],
    });
    assert.equal(existsSync(join(outside, REQUEST_ID, "precious")), true);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("finding 2: bytes the caller changes right after the call are not what is sent", { skip: !posix }, async () => {
  const result = await run(OPENAI, recording(writeOutput({ output: select })), {
    input: { payload: Buffer.from(PAYLOAD) },
    mutate: (launchInput) => launchInput.payload.fill(0x41),
  });
  assert.deepEqual(result.report.result, { outcome: "output", raw: JSON.stringify(select) });
  assert.deepEqual(result.observed("stdin"), PAYLOAD);
});

// ---------------------------------------------------------------------------
// Started: the result, the timeout, cleanup on every path
// ---------------------------------------------------------------------------

test("codex: the planned command runs with the fixed environment and the question on stdin; -o is the result", { skip: !posix }, async () => {
  const result = await run(OPENAI, recording(`${CODEX_STATE}\n${writeOutput({ output: select })}\n${events({ type: "thread.started" }, { type: "turn.completed" })}`));
  assert.deepEqual(result.report, { result: { outcome: "output", raw: JSON.stringify(select) }, cleanup: VERIFIED });
  assert.deepEqual(result.requestCleanup, VERIFIED);
  const planned = dmExecutionPlan(OPENAI, REQUEST_ID);
  assert.deepEqual(JSON.parse(result.observed("argv.json")), planned.plan.argv.slice(1));
  assert.deepEqual(JSON.parse(result.observed("env.json")), {
    HOME: "/home/amux-dm-openai",
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  });
  assert.deepEqual(result.observed("stdin"), PAYLOAD);
  assert.equal(result.observed("cwd").toString().endsWith(`/var/lib/amux-dm/requests/${REQUEST_ID}`), true);
  assert.deepEqual(result.home, [".codex/", ".codex/auth.json", "dm-scratch/"]);
  assert.equal(result.requestGone && result.temporaryGone, true);
});

test("claude: structured_output is the result; the account's state is gone afterwards", { skip: !posix }, async () => {
  const result = await run(ANTHROPIC, recording(`${CLAUDE_STATE}\n${claudeResult()}`));
  assert.deepEqual(result.report, { result: { outcome: "output", raw: JSON.stringify(select) }, cleanup: VERIFIED });
  assert.deepEqual(JSON.parse(result.observed("argv.json")), dmExecutionPlan(ANTHROPIC, REQUEST_ID).plan.argv.slice(1));
  // §5a: claude's working directory is the request directory.
  assert.equal(result.observed("cwd").toString().endsWith(`/var/lib/amux-dm/requests/${REQUEST_ID}`), true);
  assert.deepEqual(result.home, [".cache/", ".claude/", ".claude/.credentials.json", ".local/", ".local/state/", "dm-scratch/"]);
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
    assert.deepEqual(result.report, { result: { outcome: "unavailable", reason }, cleanup: VERIFIED }, reason);
    assert.deepEqual(result.requestCleanup, VERIFIED, reason);
    assert.equal(result.requestGone && result.temporaryGone, true);
  }
});

test("codex: an -o that links to another file is never read", { skip: !posix }, async () => {
  const body = `fs.symlinkSync(at(process.env.HOME + "/.codex/auth.json"), at(argv[argv.indexOf("-o") + 1]));`;
  const result = await run(OPENAI, recording(body));
  assert.deepEqual(result.report, { result: { outcome: "unavailable", reason: "result_unreadable" }, cleanup: VERIFIED });
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
  assert.deepEqual(result.report, { result: { outcome: "timeout" }, cleanup: VERIFIED });
  assert.deepEqual(result.requestCleanup, VERIFIED);
  assert.ok(Date.now() - started < 15_000);
  assert.equal(await settle(result.pidOf("self.pid")), false);
  assert.equal(await settle(result.pidOf("grandchild.pid")), false);
  assert.deepEqual(result.home, [".codex/", ".codex/auth.json", "dm-scratch/"]);
});

test("nothing of the process group outlives a normal exit, even holding stdout", { skip: !posix }, async () => {
  const body = `${writeOutput({ output: select })}
const { spawn } = require("child_process");
const child = spawn("/bin/sleep", ["60"], { stdio: ["ignore", "inherit", "ignore"] });
touch("/observed/grandchild.pid", String(child.pid));
child.unref();`;
  const result = await run(OPENAI, recording(body));
  assert.deepEqual(result.report, { result: { outcome: "output", raw: JSON.stringify(select) }, cleanup: VERIFIED });
  assert.equal(await settle(result.pidOf("grandchild.pid")), false);
});

test("an executable the account cannot run is spawn_failed, and cleanup runs", { skip: !posix }, async () => {
  const result = await run(ANTHROPIC, recording(claudeResult()), { mode: 0o644 });
  assert.deepEqual(result.report, { result: { outcome: "unavailable", reason: "spawn_failed" }, cleanup: VERIFIED });
  assert.equal(result.started, false);
  assert.equal(result.requestGone && result.temporaryGone, true);
});

test("§5: state the account cannot delete is cleanup_unknown, reported beside the result", { skip: !canChmod }, async () => {
  const body = `${writeOutput({ output: select })}
touch(process.env.HOME + "/.codex/locked/session.json", "question text could be here");
fs.chmodSync(at(process.env.HOME + "/.codex/locked"), 0o500);`;
  const result = await run(OPENAI, recording(body));
  assert.deepEqual(result.report.result, { outcome: "output", raw: JSON.stringify(select) });
  assert.equal(result.report.cleanup.status, "cleanup_unknown");
  assert.deepEqual(result.report.cleanup.residue.map((entry) => entry.kind).sort(), ["removal_failed", "state_entry_present"]);
});
