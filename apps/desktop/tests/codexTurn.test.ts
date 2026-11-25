import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";
import { codexFixtureProvider, inspectCodexSavedTurn, observeCodexFixtureTurn, type CodexSteer, type CodexTurnObservation } from "../src/host/codex-turn";
import type { Frame } from "../src/host/cli-protocol";
import { fixtureWorkAnalysis } from "../../tomverse-cli/tests/fakeGateway";

const profile = "/local/fixture-profile";
const root = "/local/fixture-project";
const model = "fixture-model";
const threadId = "thread-1";
const turnId = "turn-1";
const protocolOs = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform;
const target = { threadId, turnId };
const plan = (rows: Array<[string, string]>) => ({ method: "turn/plan/updated", params: { ...target,
  plan: rows.map(([step, status]) => ({ step, status })) } });
const item = (method: "item/started" | "item/completed", item: Frame, scope = target) => ({ method, params: { ...scope, item } });
const terminal = (status: string) => ({ method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });
const delta = (itemId: string, delta: unknown, scope = target) => ({ method: "item/agentMessage/delta", params: { ...scope, itemId, delta } });

function fixture(onTurn: (send: (frame: Frame) => void) => void, onOther?: (request: Frame, send: (response: Frame) => void) => void,
    settings: Partial<{ cwd: string; modelProvider: string; sandbox: { type: string } }> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const reader = createInterface({ input: stdin });
  const requests: Frame[] = [];
  const send = (frame: Frame) => { stdout.write(`${JSON.stringify(frame)}\n`); };
  reader.on("line", (line) => {
    const request = JSON.parse(line) as Frame;
    requests.push(request);
    if (request.method === "initialize") send({ id: request.id, result: { codexHome: profile, platformOs: protocolOs } });
    else if (request.method === "thread/start") send({ id: request.id, result: {
      cwd: root, model, modelProvider: codexFixtureProvider, reasoningEffort: "medium", approvalPolicy: "never", sandbox: { type: "readOnly" },
      thread: { id: threadId, cwd: root, ephemeral: true }, ...settings,
    } });
    else if (request.method === "turn/start") {
      send({ id: request.id, result: { turn: { id: turnId, status: "inProgress" } } });
      onTurn(send);
    } else onOther?.(request, send);
  });
  return { stdin, stdout, requests, close: () => { reader.close(); stdin.end(); stdout.end(); } };
}

test("Codex plans keep native model binding and require current-turn read evidence", async (context) => {
  const inspect = "Inspect fixture";
  const review = "Review behavior";
  const changed = "Check keyboard behavior";
  const command = { type: "commandExecution", id: "read-1", cwd: root, command: "cat marker.txt", commandActions: [{ type: "read" }] };
  const child = fixture((send) => {
    send(plan([[inspect, "inProgress"], [review, "pending"]]));
    for (const [turn, totalTokens] of [[turnId, 21], ["stale-turn", 99], [turnId, 42], [turnId, 21], [turnId, -1]]) {
      send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: turn, tokenUsage: { total: { totalTokens } } } });
    }
    send(item("item/completed", { ...command, status: "completed", exitCode: 0 }));
    send(item("item/started", { ...command, status: "inProgress" }));
    send(item("item/completed", { ...command, status: "completed", exitCode: 0 }, { ...target, turnId: "older-turn" }));
    send(item("item/completed", { ...command, command: "cat different.txt", status: "completed", exitCode: 0 }));
    send(item("item/completed", { ...command, status: "completed", exitCode: 0 }));
    send(item("item/completed", { ...command, status: "failed", exitCode: 3 }));
    send(plan([[inspect, "completed"], [review, "inProgress"]]));
    send(plan([[inspect, "pending"], [changed, "completed"]]));
    send(plan([[inspect, "completed"], [changed, "completed"], [changed, "pending"]]));
    send(plan([[changed, "completed"], [inspect, "completed"]]));
    send({ method: "item/reasoning/textDelta", params: { ...target, delta: "Internal fixture text" } });
    send(item("item/completed", { type: "agentMessage", id: "answer-1", text: "Public plan summary" }));
    send({ id: "approval-1", method: "item/fileChange/requestApproval", params: { ...target, itemId: "file-1" } });
    send(terminal("completed"));
  });
  context.after(child.close);
  const observations: CodexTurnObservation[] = [];
  const result = await observeCodexFixtureTurn(child, { profile, root, version: "0.1.0", model, prompt: "Inspect only", effort: "high",
    signal: new AbortController().signal }, (observation) => observations.push(observation));
  assert.equal(result.status, "completed");
  assert.deepEqual(result.rows.map(({ title, state }) => [title, state]), [[changed, "unverified"], [inspect, "completed"], [review, "cancelled"]]);
  assert.deepEqual(result.rows[1]?.assignment, { ...target, model });
  assert.deepEqual(result.rows[1]?.evidence, [{ id: "read-1", result: "succeeded", model: { ...target, model } }]);
  assert.equal(result.rows[0]?.assignment, undefined);
  assert.equal(result.threadEffort, "medium");
  assert.deepEqual(result.usage, { source: "codex_thread", totalTokens: 42 });
  assert.equal(result.requestedEffort, "high");
  assert.deepEqual(result.messages, [{ role: "assistant", text: "Public plan summary" }]);
  assert.ok(!JSON.stringify(observations).includes("Internal fixture text"));
  assert.ok(observations[1]?.rows.some(({ state }) => state === "running"));
  assert.deepEqual(child.requests.at(-1), { id: "approval-1", result: { decision: "decline" } });
});

test("Codex does not receive a prompt before confirming the read-only fixture settings", async (context) => {
  for (const settings of [{ cwd: "/foreign-project" }, { modelProvider: "openai" }, { sandbox: { type: "workspaceWrite" } }]) {
    const child = fixture(() => assert.fail("Turn started against an unsafe thread"), undefined, settings);
    context.after(child.close);
    await assert.rejects(observeCodexFixtureTurn(child, { profile, root, version: "0.1.0", model, prompt: "Read only",
      signal: new AbortController().signal }, () => assert.fail("Unexpected native task")));
    assert.ok(child.requests.every(({ method }) => method !== "turn/start"));
  }
});

test("Codex cannot request Desktop approval before valid analysis or reuse analysis after steering", { timeout: 3_000 }, async (context) => {
  const step = plan([["Edit the fixture", "inProgress"]]);
  const analyzed = { ...step, params: { ...step.params, explanation: JSON.stringify(fixtureWorkAnalysis) } };
  const patch = (callId: string) => ({ id: callId, method: "item/tool/call",
    params: { ...target, callId, tool: "desktop_apply_patch", arguments: {} } });
  const applied: string[] = [];
  const clientId = "312c30aa-3692-48cc-8bbf-d3b81478ad6b";
  const text = "Reconsider the scope of the edit.";
  const child = fixture((send) => {
    send({ ...analyzed, params: { ...analyzed.params, turnId: "stale-turn" } });
    send({ ...step, params: { ...step.params, explanation: JSON.stringify({ objective: "Incomplete analysis" }) } });
    send(patch("early"));
  }, (request, send) => {
    if (request.id === "early" || request.id === "stale") {
      assert.equal((request.result as Frame).success, false);
      send(analyzed);
      send(patch(request.id === "early" ? "first" : "revised"));
    }
    if (request.method === "turn/steer") {
      send({ id: request.id, result: { turnId } });
      send(item("item/completed", { type: "userMessage", id: "steer-input", clientId, content: [{ type: "text", text }] }));
      send(step);
      send(patch("stale"));
    }
    if (request.id === "revised") send(terminal("completed"));
  });
  context.after(child.close);
  let steer: CodexSteer | undefined;
  let steering: Promise<boolean> | undefined;
  const result = await observeCodexFixtureTurn(child, { profile, root, model, version: "0.1.0", prompt: "Edit the fixture.",
    signal: new AbortController().signal, patchTool: {
      spec: { type: "function", name: "desktop_apply_patch", description: "Propose a fixture edit.", inputSchema: {} },
      async invoke(callId) { applied.push(callId); return { success: true, text: "Approved patch." }; },
    },
  }, ({ rows }) => {
    if (rows.some((row) => row.evidence.some(({ id, result }) => id === "first" && result === "succeeded"))) {
      steering ??= steer?.(clientId, text);
    }
  }, (ready) => { steer = ready; });
  assert.equal(await steering, true);
  assert.deepEqual(applied, ["first", "revised"]);
  assert.deepEqual(result.rows[0]?.evidence.map(({ id }) => id), applied);
});

test("Codex preserves the model pin and labels only the bound reroute as reported execution", async (context) => {
  for (const supported of [true, false]) {
    const command = { type: "commandExecution", id: "read-after-reroute", cwd: root, command: "cat marker.txt",
      commandActions: [{ type: "read" }] };
    const reroute = (turn: string, fromModel: string, toModel: string) => ({
      method: "model/rerouted", params: { threadId, turnId: turn, fromModel, toModel },
    });
    const child = fixture((send) => {
      send(plan([["Inspect the model evidence", "inProgress"]]));
      send(reroute("stale-turn", model, "unrelated-model"));
      send(reroute(turnId, "different-assignment", "unexpected-model"));
      send(reroute(turnId, model, "reported-codex-model"));
      send(item("item/started", { ...command, status: "inProgress" }));
      send(item("item/completed", { ...command, status: "completed", exitCode: 0 }));
      send(plan([["Inspect the model evidence", "completed"]]));
      send(terminal("completed"));
    }, (request, send) => {
      if (request.method === "account/read") send({ id: request.id, result: { account: null, requiresOpenaiAuth: false } });
      if (request.method === "model/list") send({ id: request.id, result: { nextCursor: null, data: [{
        id: model, displayName: "Fixture", supportedReasoningEfforts: [{ reasoningEffort: supported ? "high" : "medium" }],
      }] } });
    });
    context.after(child.close);
    const result = await observeCodexFixtureTurn(child, { profile, root, version: "0.1.0", model, prompt: "Inspect only",
      effort: "high", verifyDestination: true, signal: new AbortController().signal }, () => undefined);
    assert.equal((child.requests.find(({ method }) => method === "thread/start")?.params as Frame).model, model);
    assert.equal((child.requests.find(({ method }) => method === "turn/start")?.params as Frame).effort, supported ? "high" : undefined);
    assert.equal(result.requestedEffort, "high");
    assert.equal(result.threadEffort, "medium");
    const assignment = { ...target, model, reportedModel: { model: "reported-codex-model", previousModel: model, source: "codex_reroute" } };
    assert.deepEqual(result.session, assignment);
    assert.deepEqual(result.rows[0]?.assignment, assignment);
    assert.deepEqual(result.rows[0]?.evidence[0]?.model, assignment);
  }
});

test("Codex checks the source before sending the first continuation prompt", async (context) => {
  const child = fixture(() => assert.fail("Source drift must prevent turn/start"));
  context.after(child.close);
  await assert.rejects(observeCodexFixtureTurn(child, { profile, root, version: "0.1.0", model, prompt: "Continue the task",
    signal: new AbortController().signal,
    verifySource: () => { throw new Error("A verified file changed"); },
  }, () => assert.fail("No turn has started")), /verified file changed/);
  assert.deepEqual(child.requests.map(({ method }) => method), ["initialize", "initialized", "thread/start"]);
});

test("Codex cannot resume a foreign thread, a stale turn or an active saved turn", async (context) => {
  const previous = { threadId, turnId: "last-saved-turn", status: "interrupted" as const };
  for (const [savedRoot, latestId, latestStatus] of [
    ["/foreign-project", previous.turnId, "interrupted"],
    [root, "newer-turn", "interrupted"],
    [root, previous.turnId, "inProgress"],
  ]) {
    const child = fixture(() => assert.fail("A mismatched checkpoint cannot start a turn"), (request, send) => {
      if (request.method === "thread/read") send({ id: request.id, result: { thread: {
        id: threadId, modelProvider: codexFixtureProvider, cwd: savedRoot, status: { type: "notLoaded" }, ephemeral: false,
      } } });
      else if (request.method === "thread/turns/list") send({ id: request.id, result: { data: [{ id: latestId, status: latestStatus }] } });
      else assert.fail("An unverified native thread cannot be resumed");
    });
    context.after(child.close);
    await assert.rejects(observeCodexFixtureTurn(child, { profile, root, version: "0.1.0", model,
      prompt: "Resume with a new instruction", history: { previous }, signal: new AbortController().signal },
    () => assert.fail("A mismatched checkpoint cannot publish running state")));
    assert.ok(child.requests.every(({ method }) => method !== "thread/resume" && method !== "turn/start"));
  }
});

test("Codex recovery only inspects the bound turn and reports individually confirmed commands", async (context) => {
  const baseline = { type: "commandExecution", cwd: root, command: "cat marker.txt",
    commandActions: [{ type: "read" }], status: "completed", exitCode: 0 };
  const record = (entry: Frame, completedAtMs: number | null = 1, scope = turnId) => ({ turnId: scope, completedAtMs, item: entry });
  const good = record({ ...baseline, id: "read-ok" });
  const items = [
    good, record({ ...baseline, id: "read-failed", status: "failed", exitCode: 1 }),
    record({ ...baseline, id: "no-evidence" }, null),
    record({ ...baseline, id: "foreign-root", cwd: "/other-project" }),
    record({ id: "private-output", type: "reasoning", content: ["Private output"] }),
  ];
  const cases = [
    { status: "interrupted", items, nextCursor: null, matches: true },
    { status: "inProgress", items, nextCursor: null, matches: true },
    { status: "interrupted", items: [...items, good], nextCursor: null, matches: false },
    { status: "interrupted", items: [record({ ...baseline, id: "foreign-turn" }, 1, "old-turn")], nextCursor: null, matches: false },
    { status: "interrupted", items, nextCursor: "another-page", matches: false },
  ] as const;
  for (const trial of cases) {
    const child = fixture(() => assert.fail("Recovery must not start a model turn"), (request, send) => {
      if (request.method === "thread/read") {
        assert.deepEqual(request.params, { threadId, includeTurns: false });
        send({ id: request.id, result: { thread: { id: threadId, cwd: root, modelProvider: codexFixtureProvider,
          status: { type: "notLoaded" }, ephemeral: false } } });
      } else if (request.method === "thread/turns/list") {
        send({ id: request.id, result: { data: [{ id: turnId, status: trial.status }] } });
      } else if (request.method === "thread/items/list") {
        assert.deepEqual(request.params, { threadId, turnId, limit: 64 });
        send({ id: request.id, result: { data: trial.items, nextCursor: trial.nextCursor } });
      } else if (request.method !== "initialized") assert.fail("Recovery attempted a modifying protocol call");
    });
    context.after(child.close);
    const lookup = inspectCodexSavedTurn(child, { profile, root, version: "0.1.0", session: { ...target, model },
      signal: new AbortController().signal });
    if (trial.matches) {
      const result = await lookup;
      assert.deepEqual([...result.commands], [
        ["read-ok", trial.status === "interrupted" ? "succeeded" : "unconfirmed"],
        ["read-failed", trial.status === "interrupted" ? "failed" : "unconfirmed"],
        ["no-evidence", "unconfirmed"], ["foreign-root", "unconfirmed"],
      ]);
    } else {
      await assert.rejects(lookup);
    }
    assert.deepEqual(child.requests.map(({ method }) => method), [
      "initialize", "initialized", "thread/read", "thread/turns/list", "thread/items/list",
    ]);
  }
});

test("Codex previews only the active public answer and replaces it with the bounded final item", { timeout: 3_000 }, async (context) => {
  const message = { id: "answer-1", type: "agentMessage" };
  const answer = "응답\n" + "a".repeat(25_000);
  let finish!: () => void;
  const child = fixture((send) => {
    send(delta(message.id, "NOT_STARTED"));
    send(item("item/started", message));
    send(delta("foreign-item", "FOREIGN_ITEM"));
    send(delta(message.id, "FOREIGN_TURN", { ...target, turnId: "old-turn" }));
    send(delta(message.id, { unexpected: true }));
    send({ method: "item/reasoning/textDelta", params: { ...target, itemId: message.id, delta: "PRIVATE_REASONING" } });
    send(delta(message.id, "Preview\u202e"));
    send(delta(message.id, "x".repeat(26_000)));
    finish = () => {
      send(item("item/completed", { ...message, text: answer }));
      send(item("item/completed", { ...message, text: "DUPLICATE" }));
      send(delta(message.id, "LATE_DELTA"));
      send(terminal("completed"));
    };
  });
  context.after(child.close);
  const recorded: CodexTurnObservation[] = [];
  const result = await observeCodexFixtureTurn(child, { profile, root, version: "0.1.0", model, prompt: "Inspect only",
    signal: new AbortController().signal }, (observation) => {
    recorded.push(observation);
    if (observation.streamingAnswer) finish();
  });
  const previews = recorded.filter(({ streamingAnswer }) => streamingAnswer);
  assert.equal(previews.length, 1);
  assert.equal(previews[0]?.streamingAnswer?.length, 24_000);
  assert.ok(previews[0]?.streamingAnswer?.startsWith("Preview\\u{202e}"));
  assert.deepEqual(previews[0]?.messages, []);
  assert.equal(result.streamingAnswer, undefined);
  assert.deepEqual(result.messages, [{ role: "assistant", text: answer.slice(0, 24_000) }]);
  assert.doesNotMatch(JSON.stringify(recorded), /NOT_STARTED|FOREIGN_ITEM|FOREIGN_TURN|PRIVATE_REASONING|DUPLICATE|LATE_DELTA/);
});

test("An incomplete native text response remains a preview when the process output closes", { timeout: 3_000 }, async (context) => {
  const child = fixture((send) => {
    send(item("item/started", { type: "agentMessage", id: "partial-answer" }));
    send(delta("partial-answer", "Partial output"));
  });
  context.after(child.close);
  const recorded: CodexTurnObservation[] = [];
  await assert.rejects(observeCodexFixtureTurn(child, { profile, root, version: "0.1.0", model, prompt: "Inspect only",
    signal: new AbortController().signal }, (observation) => {
    recorded.push(observation);
    if (observation.streamingAnswer) child.stdout.end('{"method":"item/complet');
  }), /incomplete message/);
  assert.equal(recorded.at(-1)?.streamingAnswer, "Partial output");
  assert.ok(recorded.every(({ messages }) => messages.length === 0));
});

test("Codex rejects protocol output beyond the turn byte limit", { timeout: 3_000 }, async (context) => {
  const child = fixture((send) => {
    send(item("item/started", { type: "agentMessage", id: "oversized-answer" }));
    send(delta("oversized-answer", "x".repeat(1024 * 1024)));
  });
  context.after(child.close);
  const recorded: CodexTurnObservation[] = [];
  await assert.rejects(observeCodexFixtureTurn(child, { profile, root, version: "0.1.0", model, prompt: "Inspect only",
    signal: new AbortController().signal }, (observation) => recorded.push(observation)), /exceeded its output limit/);
  assert.ok(recorded.every(({ messages, streamingAnswer }) => messages.length === 0 && !streamingAnswer));
});

test("Codex cancellation is bound to a native turn and confirmed by its terminal event", async (context) => {
  const cancel = new AbortController();
  const child = fixture((send) => send(plan([["Read the fixture", "inProgress"]])), (request, send) => {
    if (request.method !== "turn/interrupt") return;
    assert.deepEqual(request.params, target);
    send({ id: request.id, result: {} });
    send(terminal("interrupted"));
  });
  context.after(child.close);
  const result = await observeCodexFixtureTurn(child, { profile, root, version: "0.1.0", model, prompt: "Read only", signal: cancel.signal },
    ({ rows }) => { if (rows.some(({ state }) => state === "running")) cancel.abort(); });
  assert.equal(result.status, "interrupted");
  assert.equal(result.rows[0]?.state, "cancelled");
});

test("A failed native turn does not leave a plan item running or verify an unfinished command", async (context) => {
  const child = fixture((send) => {
    send(plan([["Read the fixture", "inProgress"]]));
    send(item("item/started", { type: "commandExecution", id: "read-1", cwd: root,
      command: "cat marker.txt", source: "unifiedExecStartup", commandActions: [{ type: "read" }], status: "inProgress" }));
    send(terminal("failed"));
  });
  context.after(child.close);
  const result = await observeCodexFixtureTurn(child, { profile, root, version: "0.1.0", model, prompt: "Read only",
    signal: new AbortController().signal }, () => undefined);
  assert.equal(result.status, "failed");
  assert.equal(result.rows[0]?.state, "unverified");
  assert.equal(result.rows[0]?.evidence[0]?.result, "unconfirmed");
  assert.equal(result.hasUnconfirmedCommand, true);
});

test("An unplanned command still requires confirmation before reporting Stop", async (context) => {
  const child = fixture((send) => {
    send(item("item/started", { type: "commandExecution", id: "read-1", cwd: root,
      command: "cat marker.txt", source: "unifiedExecStartup", commandActions: [{ type: "read" }], status: "inProgress" }));
    send(terminal("interrupted"));
  });
  context.after(child.close);
  const result = await observeCodexFixtureTurn(child, { profile, root, version: "0.1.0", model, prompt: "Read only",
    signal: new AbortController().signal }, () => undefined);
  assert.deepEqual(result.rows, []);
  assert.equal(result.hasUnconfirmedCommand, true);
});

test("Codex steering binds a delivered user message to its receipt and requires fresh task evidence", async (context) => {
  const initial = "Inspect the first case";
  const open = "Check the original scenario";
  const next = "Check the keyboard scenario";
  const clientId = "248bc46b-3480-4979-9ae2-22f0ce7558d6";
  const text = "Include the keyboard scenario";
  const read = (id: string, send: (frame: Frame) => void) => {
    const command = { type: "commandExecution", id, cwd: root, command: "cat marker.txt", commandActions: [{ type: "read" }] };
    send(item("item/started", { ...command, status: "inProgress" }));
    send(item("item/completed", { ...command, status: "completed", exitCode: 0 }));
  };
  const child = fixture((send) => {
    send(plan([[initial, "inProgress"], [open, "pending"]]));
    read("first", send);
    send(plan([[initial, "completed"], [open, "inProgress"]]));
    read("old-scope", send);
  }, (request, send) => {
    if (request.method !== "turn/steer") return;
    assert.deepEqual(request.params, { threadId, expectedTurnId: turnId, clientUserMessageId: clientId,
      input: [{ type: "text", text, textElements: [] }] });
    const user = { type: "userMessage", id: "user-steer", clientId, content: [{ type: "text", text }] };
    send(item("item/completed", user, { ...target, turnId: "other-turn" }));
    send(item("item/completed", { ...user, clientId: "other-input" }));
    send(item("item/completed", user));
    send({ id: request.id, result: { turnId } });
    send(item("item/completed", user));
    send({ id: request.id, result: { turnId } });
    send(plan([[initial, "completed"], [open, "completed"], [next, "inProgress"]]));
    read("new-scope", send);
    send(plan([[initial, "completed"], [open, "completed"], [next, "completed"]]));
    send(terminal("completed"));
  });
  context.after(child.close);
  let steer: CodexSteer | undefined;
  let accepted: Promise<boolean> | undefined;
  const result = await observeCodexFixtureTurn(child, { profile, root, version: "0.1.0", model, prompt: "Read only",
    signal: new AbortController().signal }, ({ rows }) => {
    if (rows.some((row) => row.title === open && row.evidence[0]?.result === "succeeded")) accepted ??= steer?.(clientId, text);
  }, (ready) => { steer = ready; });
  assert.equal(await accepted, true);
  assert.deepEqual(result.messages, [{ role: "user", text }]);
  assert.deepEqual(result.rows.map(({ state }) => state), ["completed", "unverified", "completed"]);
  assert.equal(result.rows[1]?.evidenceStart, 1);
  assert.equal(result.rows[1]?.evidence[0]?.id, "old-scope");
  assert.equal(result.rows[2]?.evidence[0]?.id, "new-scope");
});

test("Stop with a queued instruction hands termination to the process owner without sending an interrupt", async (context) => {
  const cancel = new AbortController();
  const clientId = "948bc46b-3480-4979-9ae2-22f0ce7558d6";
  const text = "Consider a different marker";
  const child = fixture((send) => send(plan([["Inspect the fixture", "inProgress"]])), (request, send) => {
    if (request.method === "turn/steer") send({ id: request.id, result: { turnId } });
  });
  context.after(child.close);
  let steer: CodexSteer | undefined;
  let accepted: Promise<boolean> | undefined;
  let sawQueue = false;
  const result = observeCodexFixtureTurn(child, { profile, root, version: "0.1.0", model, prompt: "Read only", signal: cancel.signal },
    (observation) => {
      if (observation.pendingFollowUp === text) {
        sawQueue = true;
        cancel.abort();
      } else if (observation.rows[0]?.state === "running") accepted ??= steer?.(clientId, text);
    }, (ready) => { steer = ready; });
  await assert.rejects(result);
  assert.equal(sawQueue, true);
  assert.equal(await accepted, false);
  assert.ok(child.requests.every(({ method }) => method !== "turn/interrupt"));
  assert.equal(await steer?.(clientId, text), false);
});
