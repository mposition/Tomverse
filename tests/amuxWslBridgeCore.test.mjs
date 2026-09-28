import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { boardPromotionExecutionBriefDigest } from "../lib/amux/boardPromotionCore.ts";
import { buildAmuxDeliveryPrompt } from "../lib/amux/deliveryPrompt.ts";
import {
  WSL_BRIDGE_CODE_LATCH,
  acceptLateResult,
  classifyBridgeResult,
  decideAfterReadBack,
  interpretSendResponse,
  planLocalDispatch,
  runBridgeTick,
} from "../lib/amux/wslBridgeCore.ts";

const attemptId = "4f3b1c0a-6d2e-4a18-9c0b-1a2b3c4d5e6f";

const promptFor = (brief) => {
  const digest = boardPromotionExecutionBriefDigest(brief);
  return buildAmuxDeliveryPrompt({
    taskId: "task-1",
    title: "Fix the window",
    description: "description",
    kind: "bug",
    priority: "p2",
    worker: "claude-impl",
    attemptId,
    attemptNumber: 1,
    taskRevision: 2,
    executionBrief: brief,
    executionBriefDigest: digest,
    previousAttempt: null,
  });
};

const ready = (overrides = {}) => ({
  latch: true,
  envValue: "1",
  halt: "running",
  localReachable: true,
  session: { name: "claude-impl", running: true },
  attemptId,
  prompt: promptFor("Change only the named window latch."),
  reservedAttemptIds: [],
  ...overrides,
});

test("the code latch is on and a missing env does not send", () => {
  assert.equal(WSL_BRIDGE_CODE_LATCH, true);
  const closed = planLocalDispatch(ready({ latch: WSL_BRIDGE_CODE_LATCH, envValue: undefined }));
  assert.equal(closed.action, "refuse");
  assert.equal(closed.reason, "bridge_disabled");
  const off = planLocalDispatch(ready({ latch: false }));
  assert.equal(off.reason, "bridge_latch_off");
});

test("an admitted send targets the existing session and does not open a board", () => {
  const plan = planLocalDispatch(ready());
  assert.equal(plan.action, "send");
  if (plan.action !== "send") return;
  assert.equal(plan.method, "POST");
  assert.equal(plan.path, "/api/sessions/claude-impl/send");
  assert.equal(plan.path.includes("/api/board"), false);
  assert.equal(plan.body.no_board, true);
  assert.equal(plan.body.msg_id, attemptId);
  assert.equal(Object.keys(plan.body).sort().join(), "msg_id,no_board,text");
});

test("a stopped session is not started and a reserved attempt is not sent twice", () => {
  assert.equal(
    planLocalDispatch(ready({ session: { name: "claude-impl", running: false } })).reason,
    "worker_not_running",
  );
  assert.equal(
    planLocalDispatch(ready({ reservedAttemptIds: [attemptId] })).reason,
    "duplicate_assignment",
  );
});

test("a prompt without an approved brief is not dispatched", () => {
  const absent = buildAmuxDeliveryPrompt({
    taskId: "task-1",
    title: "Fix the window",
    description: "description",
    kind: "bug",
    priority: "p2",
    worker: "claude-impl",
    attemptId,
    attemptNumber: 1,
    taskRevision: 2,
    executionBrief: null,
    executionBriefDigest: null,
    previousAttempt: null,
  });
  assert.equal(planLocalDispatch(ready({ prompt: absent })).reason, "brief_absent");
});

test("control-plane names and database URLs do not ride in the worker text", () => {
  const named = `${promptFor("Change the latch.")}\nDATABASE_URL=secret`;
  assert.equal(planLocalDispatch(ready({ prompt: named })).reason, "control_plane_leak");
  const postgres = `${promptFor("Change the latch.")}\npostgres://db.internal/app`;
  assert.equal(planLocalDispatch(ready({ prompt: postgres })).reason, "control_plane_leak");
  const postgresql = `${promptFor("Change the latch.")}\nPostgreSQL://db.internal/app`;
  assert.equal(planLocalDispatch(ready({ prompt: postgresql })).reason, "control_plane_leak");
});

test("local send success is not completion and a refused no_board is not dispatched", () => {
  const pending = interpretSendResponse({
    transport: "ok",
    status: 200,
    body: { ok: true, id: 17 },
  });
  assert.equal(pending.kind, "pending");
  assert.equal(pending.completion, false);

  const dual = interpretSendResponse({
    transport: "ok",
    status: 200,
    body: { ok: true, id: 18, no_board_refused: "substantive work gets a ledger card" },
  });
  assert.equal(dual.kind, "dual_board");
  assert.equal(dual.retry, false);
  assert.equal(dual.completion, false);
});

test("a lost response is read back before another send", () => {
  const unknown = interpretSendResponse({ transport: "unknown" });
  assert.equal(unknown.readBack, true);
  assert.equal(unknown.retry, false);
  assert.deepEqual(decideAfterReadBack(true), { send: false, halt: false });
  assert.deepEqual(decideAfterReadBack(false), { send: true, halt: false });
  assert.deepEqual(decideAfterReadBack("lookup_failed"), { send: false, halt: true });
});

test("results stay inside review todo and blocked and a stale generation is refused", () => {
  assert.equal(classifyBridgeResult("succeeded").toStatus, "review");
  assert.equal(classifyBridgeResult("failed").toStatus, "todo");
  assert.equal(classifyBridgeResult("blocked").toStatus, "blocked");
  assert.equal(classifyBridgeResult("done").accept, false);
  assert.equal(classifyBridgeResult("merged").accept, false);
  assert.equal(
    acceptLateResult({
      generation: 3,
      liveGeneration: 4,
      leaseExpiresAt: 200,
      now: 100,
    }),
    false,
  );
  assert.equal(
    acceptLateResult({
      generation: 3,
      liveGeneration: 3,
      leaseExpiresAt: 50,
      now: 100,
    }),
    false,
  );
});

test("local unreachability and a halt stop new assignments", () => {
  assert.equal(planLocalDispatch(ready({ localReachable: false })).reason, "local_unreachable");
  assert.equal(planLocalDispatch(ready({ halt: "halted" })).reason, "assignments_halted");
});

test("a latched-off tick does not call the local transport", async () => {
  let calls = 0;
  const tick = await runBridgeTick({
    ...ready({ latch: false }),
    generation: 1,
    liveGeneration: 1,
    leaseExpiresAt: 200,
    now: 100,
    workerOutcome: "succeeded",
    send: async () => {
      calls += 1;
      return { transport: "ok", status: 200, body: { ok: true, id: 1 } };
    },
    readBack: async () => false,
  });
  assert.equal(tick.disposition, "idle");
  assert.equal(calls, 0);
});

test("send success stays pending until a fenced worker result arrives", async () => {
  const pending = await runBridgeTick({
    ...ready(),
    generation: 1,
    liveGeneration: 1,
    leaseExpiresAt: 200,
    now: 100,
    workerOutcome: null,
    send: async () => ({ transport: "ok", status: 200, body: { ok: true, id: 1 } }),
    readBack: async () => false,
  });
  assert.equal(pending.disposition, "pending");

  const settled = await runBridgeTick({
    ...ready(),
    generation: 1,
    liveGeneration: 1,
    leaseExpiresAt: 200,
    now: 100,
    workerOutcome: "succeeded",
    send: async () => ({ transport: "ok", status: 200, body: { ok: true, id: 1 } }),
    readBack: async () => false,
  });
  assert.equal(settled.disposition, "settled");
  assert.equal(settled.toStatus, "review");

  const late = await runBridgeTick({
    ...ready(),
    generation: 1,
    liveGeneration: 2,
    leaseExpiresAt: 200,
    now: 100,
    workerOutcome: "succeeded",
    send: async () => ({ transport: "ok", status: 200, body: { ok: true, id: 1 } }),
    readBack: async () => false,
  });
  assert.equal(late.disposition, "result_rejected");
});

test("the rust bridge opens a client only after the exact env gate", () => {
  const bridge = readFileSync(
    new URL("../apps/tomverse-orchestrator/src/wsl_bridge.rs", import.meta.url),
    "utf8",
  );
  const binary = readFileSync(
    new URL("../apps/tomverse-orchestrator/src/bin/tomverse-wsl-bridge.rs", import.meta.url),
    "utf8",
  );
  assert.match(bridge, /pub const WSL_BRIDGE_CODE_LATCH: bool = true;/);
  assert.match(bridge, /wsl bridge does not start workers/);
  const gate = bridge.slice(bridge.indexOf("pub fn activation_gate"), bridge.indexOf("pub fn local_amux_url_allowed"));
  assert.equal(gate.includes("from_env"), false);
  const runner = bridge.slice(bridge.indexOf("pub async fn run_from_env"));
  assert.match(runner, /TomverseApi::from_env/);
  assert.match(binary, /ActivationGate::EnvOff/);
  assert.match(binary, /run_from_env/);
  assert.equal(binary.includes("TomverseApi::from_env"), false);
});
