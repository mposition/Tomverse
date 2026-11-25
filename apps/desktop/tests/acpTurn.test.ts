import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { observeAcpTurn, type AcpTurn } from "../src/host/acp-turn";
import { qwenSubscriptionBaseUrl } from "../src/host/cli-fixture-input";
import type { Frame } from "../src/host/cli-protocol";
import { bindProjectRoot } from "../src/host/project-root";

const model = "fixture-model";
const origin = "http://127.0.0.1:9222";

function acpFixture(context: TestContext, provider: "qwen" | "moonshot" | "xai" | "mistral" | "deepseek",
  mode: "default" | "plan" | "ask", qwenSubscription = false) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const reader = createInterface({ input: stdin });
  context.after(() => { reader.close(); stdin.end(); stdout.end(); });
  const kimi = provider === "moonshot";
  const grok = provider === "xai";
  const vibe = provider === "mistral";
  const deepSeek = provider === "deepseek";
  const qwenModelId = qwenSubscription ? `${model}(qwen-subscription)` : model;
  const qwenModel = { modelId: qwenModelId, _meta: { baseModelId: model, ...(qwenSubscription
    ? { baseUrl: qwenSubscriptionBaseUrl, authType: "qwen-subscription", isRuntime: false }
    : { baseUrl: `${origin}/v1`, authType: "openai", envKey: "OPENAI_API_KEY" }) } };
  const versions = { qwen: "0.28.4", moonshot: "2.7.2", xai: "1.0.92", mistral: "3.1.4", deepseek: "0.2.2-rc.2" };
  const version = versions[provider];
  const thread = "409ef18f-3153-415b-a4ec-e5379f6fcbcb";
  const sessionId = kimi ? `session_${thread}` : thread;
  const send = (frame: Frame) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  const update = (event: Frame) => send({ method: "session/update", params: { sessionId, update: event } });
  const configOptions = [
    { id: "model", currentValue: "local", options: [{ value: "local", name: model }] },
    { id: "mode", currentValue: mode, options: [{ value: mode, name: mode }] },
  ];
  let clientCapabilities: unknown;
  const onRequest = (handle: (request: Frame) => void) => reader.on("line", (line) => {
    const request = JSON.parse(line) as Frame;
    if (request.method === "initialize") clientCapabilities = (request.params as { clientCapabilities: unknown }).clientCapabilities;
    if (request.method === "initialize") send({ id: request.id, result: { protocolVersion: 1, ...(grok ? {
      agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { close: {} } },
      authMethods: [{ id: "grok.com" }, { id: "xai.api_key" }],
    } : deepSeek ? {
      agentInfo: { name: "deepseek-harness-acp", version: "0.0.1" },
      agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { close: {}, resume: {} } }, authMethods: [],
    } : { agentInfo: { name: kimi ? "Kimi Code CLI" : vibe ? "@mistralai/mistral-vibe" : "qwen-code", version },
      authMethods: vibe ? [] : [{ id: "openai" }] }) } });
    else if (request.method === "authenticate" || request.method === "session/close") send({ id: request.id, result: {} });
    else if (request.method === "session/new" && deepSeek) send({ id: request.id, result: { sessionId, configOptions: [
      { id: "model", currentValue: JSON.stringify(["deepseek-official", model]) },
      { id: "reasoning_effort", currentValue: "off" },
    ] } });
    else if (request.method === "session/new") send({ id: request.id, result: { sessionId,
      modes: { currentModeId: mode, ...(vibe && { availableModes: [{ id: "ask" }] }) }, ...(grok ? {
        models: { currentModelId: model },
        _meta: { "x.ai/sessionDetail": { sessionId, cwd: (request.params as { cwd: string }).cwd, currentModelId: model } },
      } : vibe ? { configOptions: [{ id: "model", currentValue: model }] } : kimi ? { configOptions } : { models: {
        currentModelId: qwenModelId, availableModels: [qwenModel],
      } }) } });
    else handle(request);
  });
  return { stdin, stdout, version, sessionId, send, update, onRequest, get clientCapabilities() { return clientCapabilities; } };
}

test("Qwen recognizes the current subscription limit on the scoped subscription model", { timeout: 10_000 }, async (context) => {
  const project = bindProjectRoot(await realpath(await mkdtemp(join(tmpdir(), "tomverse-qwen-quota-"))));
  context.after(() => rm(project.path, { recursive: true, force: true }));
  const requestId = "subscription-limit-fixture";
  const resetAt = 1_800_000_000;
  const quota = { subscriptionQuota: { type: "subscription_quota", requestId, resetAt } };
  const malformedMetadata = { subscriptionQuota: { type: "subscription_quota", requestId: "invalid id", resetAt: 1e16 } };
  for (const scenario of [
    { subscription: true, code: -32603, data: quota, status: "blocked" },
    { subscription: true, code: -32603, data: malformedMetadata, status: "blocked" },
    { subscription: true, code: -32003, data: quota, status: "failed" },
    { subscription: true, code: -32603, data: { details: "subscription_quota" }, status: "failed" },
    { subscription: false, code: -32603, data: quota, status: "failed" },
  ]) {
    const { stdin, stdout, version, sessionId, send, onRequest } = acpFixture(context, "qwen", "plan", scenario.subscription);
    onRequest((request) => {
      if (request.method === "session/prompt") {
        send({ id: request.id, error: { code: scenario.code, message: "The request failed.", data: scenario.data } });
      }
    });
    const result = await observeAcpTurn({ stdin, stdout }, { project, protectedRoots: [], connectionKey: "fixture-key",
      version, clientVersion: "1.0.0", model, origin, prompt: "A fixture turn", mode: "ask", provider: "qwen",
      qwenSubscription: scenario.subscription, signal: new AbortController().signal }, () => undefined);
    assert.equal(result.status, scenario.status);
    assert.deepEqual(result.quota, scenario.status === "blocked" ? { source: "qwen_code", reason: "qwenSubscriptionUsageExhausted",
      threadId: sessionId, turnId: result.session.turnId,
      ...(scenario.data === quota && { requestId, resetAt: new Date(resetAt * 1000).toISOString() }),
    } : undefined);
    assert.equal(stdout.destroyed, false);
    assert.equal(stdout.listenerCount("readable"), 0);
    const drained = once(stdout, "end");
    stdout.resume();
    stdout.end("Trailing shutdown output.");
    await drained;
  }
});

test("Vibe retry notices keep the current task pending and must match its session", { timeout: 10_000 }, async (context) => {
  const project = bindProjectRoot(await realpath(await mkdtemp(join(tmpdir(), "tomverse-vibe-retry-"))));
  context.after(() => rm(project.path, { recursive: true, force: true }));
  for (const outcome of ["completed", "failed", "foreign-session"] as const) {
    const { stdin, stdout, version, sessionId, send, update, onRequest } = acpFixture(context, "mistral", "ask");
    onRequest((request) => {
      if (request.method !== "session/prompt") return;
      send({ method: "_session/retrying", params: { sessionId: outcome === "foreign-session" ? "29b3c460-ce21-4cab-be5b-6f1c0c4a5f20" : sessionId,
        category: "rate_limited", detail: "Private retry details are not a task response." } });
      if (outcome === "foreign-session") return;
      if (outcome === "failed") {
        send({ id: request.id, error: { code: -31001, message: "Rate limit exceeded", data: { provider: "mistral", model } } });
        return;
      }
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Vibe completed the request." } });
      send({ id: request.id, result: { stopReason: "end_turn" } });
    });
    const turn = observeAcpTurn({ stdin, stdout }, { project, protectedRoots: [], connectionKey: "fixture-key",
      version, clientVersion: "1.0.0", model, origin, prompt: "A fixture turn", mode: "ask", provider: "mistral",
      signal: new AbortController().signal }, () => undefined);
    if (outcome === "foreign-session") await assert.rejects(turn, /sessionId/);
    else {
      const result = await turn;
      assert.equal(result.status, outcome);
      assert.equal(result.quota, undefined);
      assert.deepEqual(result.messages, outcome === "completed" ? [{ role: "assistant", text: "Vibe completed the request." }] : []);
    }
  }
});

test("DeepSeek usage and a terminal response require task evidence to confirm completion", { timeout: 10_000 }, async (context) => {
  const project = bindProjectRoot(await realpath(await mkdtemp(join(tmpdir(), "tomverse-deepseek-result-"))));
  context.after(() => rm(project.path, { recursive: true, force: true }));
  for (const text of ["", "DeepSeek returned a verified answer."]) {
    const { stdin, stdout, version, send, update, onRequest } = acpFixture(context, "deepseek", "ask");
    onRequest((request) => {
      if (request.method !== "session/prompt") return;
      if (text) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      update({ sessionUpdate: "usage_update", used: 443, size: 128_000 });
      send({ id: request.id, result: { stopReason: "end_turn" } });
    });
    const result = await observeAcpTurn({ stdin, stdout }, { project, protectedRoots: [], connectionKey: "fixture-key",
      version, clientVersion: "1.0.0", model, origin, prompt: "A fixture turn", mode: "ask", provider: "deepseek",
      signal: new AbortController().signal }, () => undefined);
    assert.equal(result.status, text ? "completed" : "unknown");
    assert.equal(result.quota, undefined);
    assert.equal(result.messages[0]?.text ?? "", text);
  }
});

test("Grok uses the current terminal quota code and rejects rate-limit lookalikes", { timeout: 10_000 }, async (context) => {
  const project = bindProjectRoot(await realpath(await mkdtemp(join(tmpdir(), "tomverse-acp-quota-"))));
  context.after(() => rm(project.path, { recursive: true, force: true }));
  const promptId = "672aa260-3e24-42aa-a6ae-74745adee40c";
  const marker = "subscription:free-usage-exhausted";
  const cases = [
    { code: marker, reason: "rate_limit", status: "blocked" },
    { code: "rate_limit_error", reason: "rate_limit", status: "failed" },
    { code: marker, reason: "error", status: "failed" },
  ];
  for (const scenario of cases) {
    const { stdin, stdout, version, sessionId, send, onRequest } = acpFixture(context, "xai", "default");
    onRequest((request) => {
      if (request.method !== "session/prompt") return;
      send({ method: "_x.ai/session/prompt_complete",
        params: { sessionId, promptId, agentResult: null, stopReason: scenario.reason } });
      send({ id: request.id, error: { code: -32003, message: "Rate limited",
        data: `API error (status 429 Too Many Requests): ${scenario.code}: Error detail may mention ${marker}.` } });
    });
    const result = await observeAcpTurn({ stdin, stdout }, { project, protectedRoots: [], connectionKey: "fixture-key",
      version, clientVersion: "1.0.0", model, origin, prompt: "A fixture turn", mode: "ask", provider: "xai",
      signal: new AbortController().signal }, () => undefined);
    assert.equal(result.status, scenario.status);
    assert.deepEqual(result.quota, scenario.status === "blocked" ? { source: "grok_build", reason: "grokFreeUsageExhausted",
      threadId: sessionId, turnId: result.session.turnId, promptId } : undefined);
    assert.deepEqual(result.messages, []);
  }
});

test("Grok records structured usage from the current completed prompt and ignores a fallback total", { timeout: 10_000 }, async (context) => {
  const project = bindProjectRoot(await realpath(await mkdtemp(join(tmpdir(), "tomverse-grok-usage-"))));
  context.after(() => rm(project.path, { recursive: true, force: true }));
  const reported = { inputTokens: 17, outputTokens: 6 };
  for (const { usage, expected, modelId } of [
    { usage: { ...reported, totalTokens: 23 }, expected: { source: "grok_turn", ...reported }, modelId: model },
    { usage: undefined, expected: undefined, modelId: model },
    { usage: { inputTokens: 17, outputTokens: -1 }, expected: undefined, modelId: model },
    { usage: reported, expected: undefined, modelId: "another-model" },
  ]) {
    const { stdin, stdout, version, sessionId, send, onRequest } = acpFixture(context, "xai", "default");
    onRequest((request) => {
      if (request.method === "session/prompt") send({ id: request.id, result: { stopReason: "end_turn",
        _meta: { sessionId, modelId, totalTokens: 939, usage },
      } });
    });
    const turn = observeAcpTurn({ stdin, stdout }, { project, protectedRoots: [], connectionKey: "fixture-key",
      version, clientVersion: "1.0.0", model, origin, prompt: "A fixture turn", mode: "ask", provider: "xai",
      signal: new AbortController().signal }, () => undefined);
    if (modelId !== model) await assert.rejects(turn, /different session or execution model/);
    else {
      const outcome = await turn;
      assert.equal(outcome.status, "completed");
      assert.deepEqual(outcome.usage, expected);
    }
  }
});

test("Kimi leaves silent and unsuccessful compaction responses unconfirmed", { timeout: 10_000 }, async (context) => {
  const project = bindProjectRoot(await realpath(await mkdtemp(join(tmpdir(), "tomverse-kimi-response-"))));
  context.after(() => rm(project.path, { recursive: true, force: true }));
  for (const [response, status] of [
    [[], "unknown"],
    [["Compacting conversation context…", "Compaction is blocked by the current turn; retry when the turn is idle.",
      "Compaction cancelled."], "unknown"],
    [["The provider response may describe a quota limit in ordinary prose."], "completed"],
  ] as const) {
    const { stdin, stdout, version, send, update, onRequest } = acpFixture(context, "moonshot", "default");
    onRequest((request) => {
      if (request.method !== "session/prompt") return;
      for (const text of response) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      send({ id: request.id, result: { stopReason: "end_turn" } });
    });
    const result = await observeAcpTurn({ stdin, stdout }, { project, protectedRoots: [], connectionKey: "fixture-key",
      version, clientVersion: "1.0.0", model, origin, prompt: "A fixture turn", mode: "ask", provider: "moonshot",
      signal: new AbortController().signal }, () => undefined);
    assert.equal(result.status, status);
    assert.equal(result.quota, undefined);
  }
});

for (const provider of ["qwen", "moonshot"] as const) test(
  `${provider} retains verified Task List rows and rejects invalid or late evidence`, { timeout: 5_000 }, async (context) => {
    const project = bindProjectRoot(await realpath(await mkdtemp(join(tmpdir(), "tomverse-acp-plan-"))));
    const path = join(project.path, "fixture.txt");
    const denied = join(project.path, "plan-denied.txt");
    await writeFile(path, "Expected read evidence.\n");
    context.after(() => rm(project.path, { recursive: true, force: true }));
    const kimi = provider === "moonshot";
    const agent = acpFixture(context, provider, kimi ? "default" : "plan");
    const { stdin, stdout, version, sessionId, send, update, onRequest } = agent;
    const replacement = (...rows: Array<[string, string, string]>) => update({ sessionUpdate: "plan",
      entries: rows.map(([id, content, status]) => ({ content, status, ...(!kimi && { _meta: { qwenTodo: { id } } }) })) });
    const started = (toolCallId: string) => update({ sessionUpdate: "tool_call", status: "pending", toolCallId,
      ...(kimi ? { title: "Read", kind: "read", rawInput: { path } } : { _meta: { toolName: "read_file" }, rawInput: { file_path: path } }) });
    const settled = (toolCallId: string, status: "completed" | "failed") =>
      update({ sessionUpdate: "tool_call_update", toolCallId, status });
    const read = (id: number) => send({ method: "fs/read_text_file", id, params: { sessionId, path } });
    const responses: Frame[] = [];
    onRequest((request) => {
      if (!request.method) responses.push(request);
      if (request.method === "session/prompt") {
        replacement(["read", "Read the fixture", "in_progress"], ["later", "Optional review", "pending"]);
        started("verified-read");
        read(30);
        settled("verified-read", "completed");
        settled("verified-read", "failed");
        settled("verified-read", "completed");
        replacement(["read", "Read the fixture", "completed"], ["later", "Optional review", "pending"]);
        replacement(["read", "Read the fixture", "pending"], ["read", "Read the fixture", "completed"]);
        replacement(["invalid", " ", "completed"]);
        replacement(["read", "Read the fixture", "pending"]);
        replacement(["check", "Check the result", "in_progress"], ["read", "Read the fixture", "completed"]);
        started("failed-read");
        settled("failed-read", "failed");
        read(31);
        settled("failed-read", "completed");
        replacement(["check", "Check the result", "completed"], ["read", "Read the fixture", "completed"]);
        replacement(["check", "Check the result", "completed"]);
        send({ method: "fs/write_text_file", id: 32, params: { sessionId, path: denied, content: "Unexpected edit." } });
        send({ method: "terminal/create", id: 33, params: { sessionId, command: "example" } });
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Unpublished fixture text." } });
        send({ id: request.id, result: { stopReason: "end_turn" } });
      }
    });
    const observations: AcpTurn[] = [];
    const result = await observeAcpTurn({ stdin, stdout }, { project, protectedRoots: [], connectionKey: "fixture-key",
      version, clientVersion: "1.0.0", model, origin, prompt: "Plan changes to the fixture", mode: "plan",
      signal: new AbortController().signal, provider }, (observation) => observations.push(observation));
    assert.deepEqual(agent.clientCapabilities, { fs: { readTextFile: true } });
    const initial = observations.find(({ plan }) => plan?.items[1]?.title === "Optional review")?.plan;
    assert.equal(initial?.proposalOnly, true);
    assert.equal(initial?.activeId, null);
    assert.equal(initial?.items[1]?.nativeAssignment, undefined);
    assert.equal(initial?.items[0]?.nativeAssignment?.model, model);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.plan?.items.map(({ title, complete, cancelled, evidence }) =>
      [title, complete, cancelled, evidence.map(({ state }) => state)]), [
      ["Check the result", false, false, ["failed"]],
      ["Read the fixture", false, true, ["succeeded"]],
      ["Optional review", false, true, []],
    ]);
    assert.equal(result.plan?.items[0]?.completionUnverified, false);
    assert.ok(!JSON.stringify(observations).includes("Unpublished fixture text."));
    for (const id of [32, 33]) assert.deepEqual(responses.find((response) => response.id === id)?.error,
      { code: -32602, message: "Desktop did not authorize this action." });
    await assert.rejects(readFile(denied), { code: "ENOENT" });
  });

test("ACP applies a follow-up after verified tools settle and cancels old permission requests", { timeout: 5_000 }, async (context) => {
  const project = bindProjectRoot(await realpath(await mkdtemp(join(tmpdir(), "tomverse-acp-steer-"))));
  context.after(() => rm(project.path, { recursive: true, force: true }));
  const path = join(project.path, "fixture.txt");
  const denied = join(project.path, "stale.txt");
  await writeFile(path, "The completed read stays in the work record.\n");
  const { stdin, stdout, version, sessionId, send, update, onRequest } = acpFixture(context, "qwen", "default");
  const text = "Review the file without applying the old edit";
  const responses: Frame[] = [];
  const prompts: Frame[] = [];
  let cancel = false;
  let checkCount = 0;
  onRequest((request) => {
    if (!request.method) responses.push(request);
    if (request.method === "session/prompt") {
      prompts.push(request);
      if (prompts.length === 1) {
        update({ sessionUpdate: "plan", entries: [{ content: "Read the fixture", status: "in_progress", _meta: { qwenTodo: { id: "read" } } }] });
        update({ sessionUpdate: "tool_call", status: "pending", toolCallId: "current-read",
          rawInput: { file_path: path }, _meta: { toolName: "read_file" } });
      } else {
        assert.ok(cancel);
        assert.equal(checkCount, 1);
        assert.ok(JSON.stringify(request.params).includes(text));
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The revised scope is read-only." } });
        send({ id: request.id, result: { stopReason: "end_turn" } });
      }
    }
    if (request.method === "session/cancel") {
      assert.ok(responses.some(({ id }) => id === 30));
      cancel = true;
      send({ method: "session/request_permission", id: 31, params: { sessionId } });
      send({ method: "fs/write_text_file", id: 32, params: { sessionId, path: denied, content: "Unexpected edit." } });
      send({ id: prompts[0]?.id, result: { stopReason: "cancelled" } });
    }
  });
  let queue: Parameters<NonNullable<Parameters<typeof observeAcpTurn>[3]>>[0] | undefined;
  let submitted: Promise<boolean> | undefined;
  let duplicate: Promise<boolean> | undefined;
  let firstTurn = "";
  const result = await observeAcpTurn({ stdin, stdout }, { project, protectedRoots: [], connectionKey: "fixture-key",
    version, clientVersion: "1.0.0", model, origin, prompt: "Read the fixture", mode: "agent",
    signal: new AbortController().signal, provider: "qwen", beforeFollowUp: () => { checkCount++; } }, (observation) => {
    if (submitted || observation.pendingFollowUp || observation.plan?.items[0]?.evidence[0]?.state !== "running") return;
    firstTurn = observation.session.turnId;
    assert.ok(queue);
    submitted = queue(text);
    duplicate = queue("Duplicate instruction");
    assert.equal(cancel, false);
    send({ method: "fs/read_text_file", id: 30, params: { sessionId, path } });
    update({ sessionUpdate: "tool_call_update", toolCallId: "current-read", status: "completed" });
  }, (submit) => { queue = submit; });
  assert.equal(await submitted, true);
  assert.equal(await duplicate, false);
  assert.equal(prompts.length, 2);
  assert.equal(result.status, "completed");
  assert.notEqual(result.session.turnId, firstTurn);
  assert.deepEqual(result.messages, [{ role: "user", text }, { role: "assistant", text: "The revised scope is read-only." }]);
  assert.equal(result.plan?.items[0]?.evidenceStart, 1);
  assert.equal(result.plan?.items[0]?.evidence[0]?.state, "succeeded");
  assert.deepEqual(responses.find(({ id }) => id === 31)?.result, { outcome: { outcome: "cancelled" } });
  assert.deepEqual(responses.find(({ id }) => id === 32)?.error, { code: -32602, message: "Desktop did not authorize this action." });
  await assert.rejects(readFile(denied), { code: "ENOENT" });
});
