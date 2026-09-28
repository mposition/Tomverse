import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

import {
  RUNNER_SYSTEM_PROMPT,
  outcomeForSession,
  runRunnerCycle,
} from "../scripts/engineering-agent-runner-core.mjs";

// The runner service's cycle (docs/policy/engineering-agent.md §2.1, §6-§8,
// §10-§12) against fake ports: what it asks the app, in what order, and how
// every ending becomes a run outcome.

const SHA = "a".repeat(40);

const fakeApp = (overrides = {}) => {
  const calls = [];
  const answers = {
    "worker/register": { status: 200, json: { registered: true, generation: 3 } },
    "worker/heartbeat": (body) => ({
      status: 200,
      json: { accepted: true, dispatchReady: body.dispatchReady, leaseExpiresAt: "x" },
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
    "run/finish": { status: 200, json: { settled: true, taskRevision: 3 } },
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

const ports = (app, model, clone = fakeClone()) => ({
  app,
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
    ["worker/register", "worker/heartbeat", "run/start", "delivery/pull", "delivery/ack", "run/draft", "run/finish", "worker/heartbeat"],
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
    "worker/heartbeat": () => ({ status: 200, json: { accepted: true, dispatchReady: false } }),
  });
  const quiet = await runRunnerCycle(ports(notReady.app, okModel));
  assert.equal(quiet.finishedNormally, true);
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
  assert.deepEqual(result, { finishedNormally: false, halt: "none", reason: "run_lease_lost" });
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
