import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

import {
  RUNNER_SYSTEM_PROMPT,
  haltOf,
  observeUnbound,
  outcomeForSession,
  runRunnerCycle,
} from "../scripts/engineering-agent-runner-core.mjs";
import { superviseCycle, SUPERVISED_ENV } from "../scripts/engineering-agent-supervisor.mjs";
import { prBodyMarker, shouldSendSuccessHeartbeat } from "../lib/engineeringAgentCore.ts";

// The runner service's cycle (docs/policy/engineering-agent.md §2.1, §6-§8,
// §10-§12) against fake ports: what it asks the app, in what order, and how
// every ending becomes a run outcome.

const SHA = "a".repeat(40);

const fakeApp = (overrides = {}) => {
  const calls = [];
  const answers = {
    "worker/register": { status: 200, json: { registered: true, generation: 3 } },
    "observe/known": { status: 200, json: { bindings: [], consumed: [] } },
    "observe/halt": { status: 200, json: { recorded: true } },
    "worker/heartbeat": (body) => ({
      status: 200,
      json: { accepted: true, dispatchReady: body.dispatchReady, leaseExpiresAt: "x", halt: "none" },
    }),
    "run/start": { status: 200, json: { started: true, runId: "123456789012", taskId: "t", attemptId: "att", taskRevision: 2 } },
    "delivery/pull": {
      status: 200,
      json: {
        available: true,
        delivery: {
          attemptId: "att",
          taskId: "t",
          taskRevision: 2,
          receiptId: "r",
          brief: { text: "Fix the typo in the footer.", digest: "d" },
          briefIssue: null,
        },
      },
    },
    "delivery/ack": { status: 200, json: { acknowledged: true } },
    "run/heartbeat": { status: 200, json: { renewed: true } },
    "run/draft": { status: 200, json: { workItemId: "w" } },
    "run/finish": { status: 200, json: { settled: true, taskRevision: 3, halt: "none" } },
    ...overrides,
  };
  const app = async (path, body) => {
    calls.push({ path, body });
    const answer = answers[path];
    return typeof answer === "function" ? answer(body) : answer;
  };
  return { app, calls };
};

const fakeClone = (applies = true) => ({
  root: "/clone",
  trackedPaths: new Set(["README.md"]),
  fsPorts: {},
  applies: async () => applies,
  dispose: async () => undefined,
});

const ports = (app, model, clone = fakeClone(), namespace = { refs: [], pulls: [] }, digests = {}) => ({
  app,
  namespace: async () => namespace,
  commitDigestAt: async (sha) => digests[sha] ?? null,
  developHead: async () => SHA,
  clone: async () => clone,
  model,
  setInterval: () => 1,
  clearInterval: () => undefined,
});

const patch = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n";
const okModel = async () => ({ ok: true, result: { manifest: { summary: "s", tests: [] }, patch }, turns: 1, toolBytes: 0 });

test("a full cycle drafts a T2 patch and ends the run as a T2 draft", async () => {
  const { app, calls } = fakeApp();
  const result = await runRunnerCycle(ports(app, okModel));
  assert.deepEqual(result, { finishedNormally: true, halt: "none", reason: "t2_draft" });
  assert.deepEqual(
    calls.map((call) => call.path),
    ["worker/register", "observe/known", "observe/known", "worker/heartbeat", "run/start", "delivery/pull", "delivery/ack", "run/draft", "run/finish", "worker/heartbeat"],
  );
  const start = calls.find((call) => call.path === "run/start").body;
  assert.equal(start.baseSha, SHA);
  assert.equal("worker" in start, false, "the runner never names a worker");
  assert.equal("taskId" in start, false, "AMUX picks the card");
  const draft = calls.find((call) => call.path === "run/draft").body;
  assert.equal(draft.patchDigest, createHash("sha256").update(patch, "utf8").digest("hex"));
  const finish = calls.find((call) => call.path === "run/finish").body;
  assert.equal(finish.outcome, "t2_draft");
  assert.equal(finish.usageMicrousd, null, "unknown spend is null, never zero");
  assert.equal(finish.halt, "none");
});

test("nothing to do is a normal cycle: closed adapter, not dispatch-ready, nothing assigned", async () => {
  const closed = fakeApp({ "worker/register": { status: 409, json: { refused: "adapter_closed" } } });
  assert.equal((await runRunnerCycle(ports(closed.app, okModel))).finishedNormally, true);
  assert.deepEqual(closed.calls.map((call) => call.path), ["worker/register"]);

  const notReady = fakeApp({
    "worker/heartbeat": () => ({ status: 200, json: { accepted: true, dispatchReady: false, halt: "none" } }),
  });
  const quiet = await runRunnerCycle(ports(notReady.app, okModel));
  assert.equal(quiet.finishedNormally, true);
  assert.equal(shouldSendSuccessHeartbeat(quiet), true, "off, frozen or a full queue is still a live round");
  assert.equal(notReady.calls.some((call) => call.path === "run/start"), false, "a worker the app will not dispatch starts nothing");

  const nothing = fakeApp({ "run/start": { status: 409, json: { started: false, reason: "nothing_assigned" } } });
  const none = await runRunnerCycle(ports(nothing.app, okModel));
  assert.deepEqual(none, { finishedNormally: true, halt: "none", reason: "nothing_assigned" });
});

test("every other ending becomes the outcome the policy names, and a failure is never no change", async () => {
  const cases = [
    [async () => ({ ok: false, reason: "no_change" }), "no_change"],
    [async () => ({ ok: false, reason: "schema_invalid" }), "schema_invalid"],
    [async () => ({ ok: false, reason: "refused" }), "agent_failed"],
    [async () => ({ ok: false, reason: "provider_error", status: 529 }), "agent_failed"],
    [async () => ({ ok: false, reason: "turn_limit" }), "agent_failed"],
  ];
  for (const [model, outcome] of cases) {
    const { app, calls } = fakeApp();
    const result = await runRunnerCycle(ports(app, model));
    assert.equal(result.reason, outcome);
    assert.equal(calls.find((call) => call.path === "run/finish").body.outcome, outcome);
    assert.equal(calls.some((call) => call.path === "run/draft"), false);
  }
  const unappliable = fakeApp();
  const refused = await runRunnerCycle(ports(unappliable.app, okModel, fakeClone(false)));
  assert.equal(refused.reason, "schema_invalid", "a patch git will not apply is not submitted");

  const noBrief = fakeApp({
    "delivery/pull": { status: 200, json: { available: true, delivery: { attemptId: "att", receiptId: "r", taskRevision: 2, brief: null, briefIssue: "digest_mismatch" } } },
  });
  assert.equal((await runRunnerCycle(ports(noBrief.app, okModel))).reason, "schema_invalid");

  const secret = fakeApp({ "run/draft": { status: 409, json: { refused: "secret_detected" } } });
  assert.equal((await runRunnerCycle(ports(secret.app, okModel))).reason, "secret_detected");
  assert.equal(outcomeForSession({ ok: true }), null);
});

test("a lost lease ends the cycle without claiming an ending it cannot record", async () => {
  const { app, calls } = fakeApp({ "run/heartbeat": { status: 409, json: { renewed: false } } });
  let tick = null;
  const cycle = runRunnerCycle({
    ...ports(app, async () => {
      await tick();
      return okModel();
    }),
    setInterval: (fn) => {
      tick = async () => {
        fn();
        await new Promise((resolve) => setImmediate(resolve));
      };
      return 1;
    },
  });
  const result = await cycle;
  assert.deepEqual(result, { finishedNormally: false, halt: "unknown", reason: "run_lease_lost" });
  assert.equal(calls.some((call) => call.path === "run/finish"), false);
});

test("the prompt says the brief is data, and the model has one tool and no way to run anything", () => {
  assert.match(RUNNER_SYSTEM_PROMPT, /data/);
  assert.match(RUNNER_SYSTEM_PROMPT, /read_file/);
  assert.match(RUNNER_SYSTEM_PROMPT, /cannot run anything/);
});

test("the runner imports node builtins and the dependency-free core, and nothing else", () => {
  const allowedLib = new Set([
    "lib/engineeringAgentModelCall.ts",
    "lib/engineeringAgentCore.ts",
  ]);
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gms)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      assert.ok(specifier.startsWith("./") || specifier.startsWith("../"), `${file} imports ${specifier}`);
      const target = normalize(join(dirname(file), specifier)).replaceAll("\\", "/");
      assert.ok(
        target.startsWith("scripts/engineering-agent-") || allowedLib.has(target),
        `${file} reaches ${target}`,
      );
      visit(target);
    }
  };
  visit("scripts/engineering-agent-runner.mjs");
  assert.ok(seen.has("lib/engineeringAgentModelCall.ts"));
});

test("while anything halts, no round sends a success signal (§12, §13-17)", async () => {
  const halted = fakeApp({
    "worker/heartbeat": () => ({ status: 200, json: { accepted: true, dispatchReady: false, halt: "circuit_open" } }),
  });
  const quiet = await runRunnerCycle(ports(halted.app, okModel));
  assert.equal(quiet.halt, "circuit_open");
  assert.equal(shouldSendSuccessHeartbeat(quiet), false);

  const endsHalted = fakeApp({ "run/finish": { status: 200, json: { settled: true, taskRevision: 3, halt: "state_mismatch" } } });
  const ended = await runRunnerCycle(ports(endsHalted.app, okModel));
  assert.equal(ended.finishedNormally, true);
  assert.equal(shouldSendSuccessHeartbeat(ended), false, "a run that ends into a halt is not a healthy round");

  const silent = fakeApp({ "worker/heartbeat": () => ({ status: 200, json: { accepted: true, dispatchReady: false } }) });
  const unknown = await runRunnerCycle(ports(silent.app, okModel));
  assert.equal(unknown.halt, "unknown", "an app that names no halt is not taken to have none");
  assert.equal(shouldSendSuccessHeartbeat(unknown), false);
  assert.equal(haltOf({ halt: "made_up" }), "unknown");
});

test("a branch or pull request passes only at a bound head or an allowed commit, by content not by name", async () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);
  const allowed = "d".repeat(64);
  const known = {
    bindings: [{ runId: "111", prNumber: 7, headSha: A, verifiedHeadSha: A }],
    consumed: [{ runId: "222", commitDigest: allowed }],
  };
  const digests = { [C]: allowed, [B]: "e".repeat(64) };
  const commitDigestAt = async (sha) => digests[sha] ?? null;
  const observe = (refs, pulls) => observeUnbound({ refs, pulls, known, commitDigestAt });
  const bound = { number: 7, headRef: "agent/engineering/111", headSha: A, body: prBodyMarker("111") };

  assert.equal(await observe([{ ref: "refs/heads/agent/engineering/111", sha: A }], [bound]), "none");
  assert.equal(await observe([{ ref: "refs/heads/agent/engineering/111", sha: B }], []), "unbound_app_ref", "a bound run's branch moved");
  assert.equal(await observe([], [{ ...bound, headSha: B }]), "unbound_app_pr", "a bound pull request's head moved");
  assert.equal(
    await observe([{ ref: "refs/heads/agent/engineering/222", sha: C }], [{ number: 8, headRef: "agent/engineering/222", headSha: C, body: prBodyMarker("222") }]),
    "none",
    "the publisher's own push and PR, before its result, at exactly the allowed commit",
  );
  assert.equal(await observe([{ ref: "refs/heads/agent/engineering/222", sha: B }], []), "unbound_app_ref", "a consumed run at another commit");
  assert.equal(
    await observe([], [{ number: 8, headRef: "agent/engineering/222", headSha: C, body: "no marker" }]),
    "unbound_app_pr",
    "an unbound pull request needs the run marker too",
  );
  assert.equal(await observe([{ ref: "refs/heads/agent/engineering/333", sha: C }], []), "unbound_app_ref", "no record of the run");
  assert.equal(await observe([{ ref: "refs/heads/agent/engineering/not-a-run", sha: A }], []), "unbound_app_ref");
  assert.equal(await observe([], [{ number: 9, headRef: "feature/x", headSha: A, body: "<!-- engineering-agent run=5 -->" }]), "unbound_app_pr");
  assert.equal(await observe([], [{ number: 10, headRef: "feature/x", headSha: A, body: "hello" }]), "none");

  const { app, calls } = fakeApp();
  const result = await runRunnerCycle(ports(app, okModel, fakeClone(), { refs: [{ ref: "refs/heads/agent/engineering/999", sha: A }], pulls: [] }));
  assert.deepEqual(result, { finishedNormally: true, halt: "unbound_app_ref", reason: "observed_unbound" });
  assert.deepEqual(calls.find((call) => call.path === "observe/halt").body, { halt: "unbound_app_ref" });
  assert.equal(calls.some((call) => call.path === "run/start"), false, "nothing starts after an unbound observation");
  assert.equal(shouldSendSuccessHeartbeat(result), false);

  const unreadable = fakeApp({ "observe/known": { status: 500, json: null } });
  assert.equal((await runRunnerCycle(ports(unreadable.app, okModel))).finishedNormally, false);
});

test("an unreadable commit leaves the observation undetermined, and a bound run passes only at its bound head", async () => {
  const A = "a".repeat(40);
  const C = "c".repeat(40);
  const allowed = "d".repeat(64);
  const unbound = { bindings: [], consumed: [{ runId: "222", commitDigest: allowed }] };
  assert.equal(
    await observeUnbound({ refs: [{ ref: "refs/heads/agent/engineering/222", sha: C }], pulls: [], known: unbound, commitDigestAt: async () => null }),
    "undetermined",
  );
  const { app, calls } = fakeApp({ "observe/known": { status: 200, json: unbound } });
  const round = await runRunnerCycle(ports(app, okModel, fakeClone(), { refs: [{ ref: "refs/heads/agent/engineering/222", sha: C }], pulls: [] }));
  assert.deepEqual(round, { finishedNormally: false, halt: "unknown", reason: "observation_undetermined" });
  assert.equal(calls.some((call) => call.path === "observe/halt"), false, "nothing recorded for an object not read");

  // One unread entry does not hide a definite one beside it.
  assert.equal(
    await observeUnbound({
      refs: [
        { ref: "refs/heads/agent/engineering/222", sha: C },
        { ref: "refs/heads/agent/engineering/333", sha: A },
      ],
      pulls: [],
      known: unbound,
      commitDigestAt: async () => null,
    }),
    "unbound_app_ref",
  );
  assert.equal(
    await observeUnbound({ refs: [{ ref: "refs/heads/agent/engineering/222", sha: null }], pulls: [], known: unbound, commitDigestAt: async () => allowed }),
    "undetermined",
    "a missing sha cannot be compared either",
  );
  const bound = {
    bindings: [{ runId: "222", prNumber: 7, headSha: A, verifiedHeadSha: A }],
    consumed: [{ runId: "222", commitDigest: allowed }],
  };
  assert.equal(
    await observeUnbound({ refs: [{ ref: "refs/heads/agent/engineering/222", sha: C }], pulls: [], known: bound, commitDigestAt: async () => allowed }),
    "unbound_app_ref",
    "once bound, an earlier allowed commit is not the run's",
  );
});

test("a list GitHub did not give whole leaves the round undetermined, and a definite finding in the other is still recorded", async () => {
  const known = { bindings: [], consumed: [] };
  const digestAt = async () => null;
  assert.equal(await observeUnbound({ refs: null, pulls: [], known, commitDigestAt: digestAt }), "undetermined");
  assert.equal(await observeUnbound({ refs: [], pulls: null, known, commitDigestAt: digestAt }), "undetermined");
  assert.equal(
    await observeUnbound({ refs: [{ ref: "refs/heads/agent/engineering/5", sha: "a".repeat(40) }], pulls: null, known, commitDigestAt: digestAt }),
    "unbound_app_ref",
  );
  assert.equal(
    await observeUnbound({ refs: null, pulls: [{ number: 3, headRef: "agent/engineering/5", headSha: "a".repeat(40), body: "" }], known, commitDigestAt: digestAt }),
    "unbound_app_pr",
  );
  const { app, calls } = fakeApp();
  const round = await runRunnerCycle(ports(app, okModel, fakeClone(), { refs: [{ ref: "refs/heads/agent/engineering/5", sha: "a".repeat(40) }], pulls: null }));
  assert.equal(round.halt, "unbound_app_ref");
  assert.deepEqual(calls.find((call) => call.path === "observe/halt").body, { halt: "unbound_app_ref" });
  const quiet = fakeApp();
  const undetermined = await runRunnerCycle(ports(quiet.app, okModel, fakeClone(), { refs: [], pulls: null }));
  assert.deepEqual(undetermined, { finishedNormally: false, halt: "unknown", reason: "observation_undetermined" });
  assert.equal(quiet.calls.some((call) => call.path === "observe/halt"), false);
});

test("the app's records must not move while GitHub is read, or nothing is judged", async () => {
  let reads = 0;
  const moving = fakeApp({
    "observe/known": () => {
      reads += 1;
      return { status: 200, json: { bindings: [], consumed: reads === 1 ? [] : [{ runId: "999", commitDigest: "f".repeat(64) }] } };
    },
  });
  const result = await runRunnerCycle(
    ports(moving.app, okModel, fakeClone(), { refs: [{ ref: "refs/heads/agent/engineering/999", sha: "a".repeat(40) }], pulls: [] }),
  );
  assert.deepEqual(result, { finishedNormally: false, halt: "unknown", reason: "observation_raced" });
  assert.equal(moving.calls.some((call) => call.path === "observe/halt"), false, "a raced reading records no halt");
});

test("the supervisor runs the cycle in its own process group and kills the group at the deadline", async () => {
  const listeners = {};
  const spawned = [];
  const killed = [];
  const fetched = [];
  let fire = null;
  const timers = [];
  const child = { pid: 4242, on: (name, fn) => void (listeners[name] = fn) };
  const done = superviseCycle({
    deadlineMs: 1000,
    failUrl: "https://deadman.example/fail",
    event: "test_deadline",
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return child;
    },
    kill: (pid, signal) => killed.push([pid, signal]),
    fetchImpl: async (url) => void fetched.push(url),
    setTimer: (fn, ms) => {
      timers.push(ms);
      // The deadline is held for the test to fire; the grace passes at once.
      if (fire === null) fire = fn;
      else fn();
      return timers.length;
    },
    clearTimer: () => undefined,
    graceMs: 5_000,
    execPath: "/usr/bin/node",
    execArgv: ["--experimental-strip-types"],
    argv: ["/usr/bin/node", "scripts/engineering-agent-runner.mjs"],
    env: { A: "1" },
  });
  assert.equal(spawned[0].options.detached, true, "a process group of its own");
  assert.equal(spawned[0].options.env[SUPERVISED_ENV], "1");
  assert.deepEqual(spawned[0].args, ["--experimental-strip-types", "scripts/engineering-agent-runner.mjs"]);
  await fire();
  assert.equal(await done, 70);
  assert.deepEqual(killed, [[-4242, "SIGTERM"], [-4242, "SIGKILL"]], "the whole group, by negative pid: a chance to revoke, then the kill");
  assert.deepEqual(timers, [1000, 5000]);
  assert.deepEqual(fetched, ["https://deadman.example/fail"], "the failure signal, never the success one");
  listeners.exit?.(137);
  assert.equal(killed.length, 2, "an exit after the deadline changes nothing");

  const normal = [];
  const exits = {};
  const finished = superviseCycle({
    deadlineMs: 1000,
    failUrl: null,
    event: "test",
    spawnImpl: () => ({ pid: 7, on: (name, fn) => void (exits[name] = fn) }),
    kill: (pid, signal) => normal.push([pid, signal]),
    setTimer: () => 1,
    clearTimer: () => undefined,
    argv: ["node", "x.mjs"],
    execArgv: [],
    env: {},
  });
  exits.exit(0);
  assert.equal(await finished, 0);
  assert.deepEqual(normal, [[-7, "SIGKILL"]], "anything the worker left behind ends with it");
});
