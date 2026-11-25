import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { observeClaudeFixtureTurn, type ClaudeTurnObservation } from "../src/host/claude-turn";
import { claudePatchProtocol, type ClaudePatchProposal } from "../src/host/claude-patch-protocol";
import type { Frame } from "../src/host/cli-protocol";
import { claudeFixtureExecution } from "../src/code-execution";
import { readNativeHistory, restoredNativeTask, saveNativeHistory } from "../src/host/native-history";
import { nativePatchName, nativePatches } from "../src/host/native-patches";
import { bindProjectRoot } from "../src/host/project-root";

const sessionId = "f64cc712-1b61-45c6-9f27-043cb767ab54";
const turnId = "923636d7-887e-4e59-814c-ffac6447d452";
const model = "fixture-model";

async function fixture(context: TestContext, frames: Frame[]) {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-claude-unit-"));
  const project = bindProjectRoot(temp);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const reader = createInterface({ input: stdin });
  const send = (frame: Frame) => { stdout.write(`${JSON.stringify(frame)}\n`); };
  reader.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.type === "control_request") {
      send({ type: "control_response", response: { request_id: request.request_id, subtype: "success",
        response: { current_permission_mode: "plan", models: [] } } });
    } else if (request.type === "user") {
      send({ type: "command_lifecycle", session_id: sessionId, command_uuid: turnId, state: "started" });
      send({ type: "system", subtype: "init", session_id: sessionId, cwd: project.path, model, permissionMode: "plan",
        tools: ["Read", "TaskCreate", "TaskUpdate"], mcp_servers: [], slash_commands: [] });
      for (const frame of frames) send({ session_id: sessionId, ...frame });
      stdout.end();
    }
  });
  context.after(async () => {
    reader.close();
    stdin.end();
    stdout.end();
    await rm(temp, { recursive: true, force: true });
  });
  return { child: { stdout, stdin }, project, sessionId, turnId, model, prompt: "Inspect", signal: new AbortController().signal };
}

const call = (id: string, name: string, input: object) => ({
  type: "assistant", uuid: `assistant-${id}`, message: { model, content: [{ type: "tool_use", id, name, input }] },
});
const receipt = (tool_use_id: string, result: object) => ({
  type: "user", message: { content: [{ type: "tool_result", tool_use_id }] }, tool_use_result: result,
});
const completed = { type: "result", subtype: "success", terminal_reason: "completed", is_error: false };
const eventId = "8c106ec2-9b8c-42df-b94c-5f76fa575a45";
const creditsRequired = { type: "rate_limit_event", uuid: eventId,
  rate_limit_info: { status: "rejected", errorCode: "credits_required" } };
const terminalQuota = { type: "result", subtype: "error_during_execution", terminal_reason: "api_error",
  is_error: true, user_message_uuid: turnId, api_error_status: 429 };

test("Claude Code uses matched task acknowledgments and requires read evidence for completion", async (context) => {
  const subject = "Inspect the fixture";
  const { child, ...input } = await fixture(context, [
    call("create", "TaskCreate", { subject }),
    receipt("stale", { task: { id: "1", subject } }),
    { ...receipt("create", { task: { id: "wrong", subject } }), session_id: "unrelated-session" },
    receipt("create", { task: { id: "1", subject } }),
    receipt("create", { task: { id: "duplicate", subject } }),
    call("update", "TaskUpdate", { taskId: "1", status: "in_progress" }),
    receipt("update", { taskId: "1", success: true, updatedFields: ["status"], statusChange: { from: "pending", to: "in_progress" } }),
    call("complete", "TaskUpdate", { taskId: "1", status: "completed" }),
    receipt("complete", { taskId: "1", success: true, updatedFields: ["status"], statusChange: { from: "in_progress", to: "completed" } }),
    completed,
  ]);
  const views: ClaudeTurnObservation[] = [];
  const result = await observeClaudeFixtureTurn(child, input, (view) => views.push(view));
  assert.deepEqual(views.slice(0, 2).map((view) => view.plan), [undefined, undefined]);
  assert.equal(result.status, "completed");
  assert.equal(result.plan?.items.length, 1);
  assert.deepEqual(result.plan?.items[0]?.nativeAssignment, { threadId: sessionId, turnId, provider: "anthropic", model,
    reportedModel: { model, source: "claude_assistant" } });
  assert.equal(result.plan?.items[0]?.complete, false);
  assert.equal(result.plan?.items[0]?.completionUnverified, true);
});

test("Claude Code cannot acknowledge an excluded tool as successful", async (context) => {
  const { child, ...input } = await fixture(context, [
    call("forbidden", "Write", { file_path: "fixture-denied.txt", content: "fixture" }),
    receipt("forbidden", { success: true }),
    completed,
  ]);
  await assert.rejects(observeClaudeFixtureTurn(child, input, () => undefined), /unsupported tool as successful/);
});

test("older Claude plans restore proposed rows and preserve the original read receipts", () => {
  const session = { threadId: sessionId, turnId, model, provider: "anthropic" as const };
  const checkpoint: Parameters<typeof restoredNativeTask>[0] = {
    provider: "anthropic", version: 1, id: "s-20261123-010203-abcd12", root: tmpdir(), title: "Inspect", mode: "plan",
    status: "completed", entries: [], nativeSession: session,
    plan: { activeId: null, items: [{ id: "claude-1", title: "Inspect the fixture", nativeStatus: "completed", complete: true,
      cancelled: false, evidence: [{ tool: "read_file", state: "succeeded", assignment: session, nativeItemId: "read" }] }] },
  };
  const restored = restoredNativeTask(checkpoint);
  assert.equal(restored.plan?.proposalOnly, true);
  assert.equal(restored.plan?.items[0]?.complete, false);
  assert.equal(restored.plan?.items[0]?.nativeStatus, "completed");
  assert.deepEqual(restored.plan?.items[0]?.evidence, checkpoint.plan?.items[0]?.evidence);
  assert.equal(checkpoint.plan?.items[0]?.complete, true);
});

test("Claude Code rechecks the current analysis after Desktop approves a patch", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-claude-approval-"));
  const root = join(temp, "project");
  const records = join(temp, "records");
  await Promise.all([mkdir(root), mkdir(records)]);
  const project = bindProjectRoot(root);
  const { signal } = new AbortController();
  let current = true;
  let approvals = 0;
  const { tool, journal } = nativePatches({
    directory: records, id: "s-20261123-121500-a0b0c0", project, protectedRoots: [], model, connectionKey: "fixture", signal,
    approve: async () => { approvals++; current = false; return true; },
  });
  context.after(async () => {
    journal.release();
    await rm(temp, { recursive: true, force: true });
  });
  const proposal: ClaudePatchProposal = {
    input: { explanation: "Record the approved output", edits: [{ path: "stale.txt", action: "create", content: "Stale output\n" }] },
    canApply: () => current,
  };
  await new Promise<void>((resolve, reject) => {
    const protocol = claudePatchProtocol(tool, () => { if (proposal.result) resolve(); }, signal,
      (id) => id === "patch" ? proposal : undefined, reject);
    const send = (method: string, id?: number, params?: object) => protocol.receive({
      type: "control_request", request_id: `request-${id ?? "initialized"}`, request: {
        subtype: "mcp_message", server_name: "desktop", message: { jsonrpc: "2.0", id, method, params },
      },
    });
    send("initialize", 0, { protocolVersion: "2025-11-25" });
    send("notifications/initialized");
    send("tools/list", 1);
    send("tools/call", 2, { name: nativePatchName, arguments: proposal.input, _meta: { "claudecode/toolUseId": "patch" } });
  });
  assert.equal(approvals, 1);
  assert.equal(proposal.result?.success, false);
  assert.equal(journal.state.approvals.length, 0);
  await assert.rejects(readFile(join(project.path, "stale.txt")), { code: "ENOENT" });
});

test("Claude usage is accepted from the matching turn result without importing cumulative cost", async (context) => {
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: null };
  for (const [resultTurn, expected] of [[turnId, { source: "claude_turn", inputTokens: 10, outputTokens: 20,
    cacheReadTokens: 3, cacheWriteTokens: undefined }], [sessionId, undefined]] as const) {
    const { child, ...input } = await fixture(context, [{ ...completed, user_message_uuid: resultTurn, total_cost_usd: 17, usage }]);
    const result = await observeClaudeFixtureTurn(child, input, () => undefined);
    assert.deepEqual(result.usage, expected);
    assert.doesNotMatch(JSON.stringify(result), /total_cost_usd/);
  }
});

test("Claude Code records the documented subscription refusal for the matching terminal turn", async (context) => {
  const { child, ...input } = await fixture(context, [
    call("create", "TaskCreate", { subject: "Keep the existing plan" }),
    receipt("create", { task: { id: "1", subject: "Keep the existing plan" } }),
    creditsRequired,
    { type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: "Limit reached" }] } },
    terminalQuota,
  ]);
  const result = await observeClaudeFixtureTurn(child, input, () => undefined);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.quota, { source: "claude_code", reason: "credits_required", threadId: sessionId, turnId, eventId });
  assert.equal(result.plan?.items[0]?.title, "Keep the existing plan");
  assert.deepEqual(result.messages, []);
  const home = join(input.project.path, "history");
  await mkdir(home);
  const taskId = "s-20261123-010203-abcd12";
  const continuation = { segmentId: "6431b7fb-6454-4dd8-99b2-675b798c910a", model: "api-model",
    maximumKeyCreditCap: 20, transfer: "summary" as const };
  const task = {
    id: taskId, root: input.project.path, title: "Inspect", status: "blocked" as const, entries: [],
    changes: [], checks: [], transmission: [], execution: claudeFixtureExecution, readOnly: true, savedLocally: true,
    nativeSession: result.session, quota: result.quota, plan: result.plan,
  };
  saveNativeHistory(home, task, "plan", false, continuation);
  const checkpoint = readNativeHistory(home, taskId, input.project.path, "anthropic");
  assert.ok(checkpoint);
  assert.deepEqual(checkpoint.continuation, continuation);
  assert.equal(readNativeHistory(home, taskId, input.project.path, "openai"), null);
  const restored = restoredNativeTask(checkpoint);
  assert.deepEqual(restored.quota, result.quota);
  assert.equal(restored.canResume, false);
  assert.equal(restored.continuation?.source.provider, "anthropic");
  assert.throws(() => saveNativeHistory(home, { ...task, nativeSession: { ...result.session, turnId: sessionId } }, "plan"));
});

test("Claude Code leaves generic, stale and still-active responses ineligible for quota continuation", async (context) => {
  const cases: Array<[string, Frame[], string]> = [
    ["generic 429", [terminalQuota], "failed"],
    ["subscription warning", [{ ...creditsRequired, rate_limit_info: { status: "allowed_warning" } }, terminalQuota], "failed"],
    ["wrong session", [{ ...creditsRequired, session_id: turnId }, terminalQuota], "failed"],
    ["subagent event", [{ ...creditsRequired, agent_id: "other-agent" }, terminalQuota], "failed"],
    ["wrong result turn", [creditsRequired, { ...terminalQuota, user_message_uuid: sessionId }], "failed"],
    ["credential error", [creditsRequired, { ...terminalQuota, api_error_status: 401 }], "failed"],
    ["queued turn", [creditsRequired, { ...terminalQuota, queued_turn_count: 1 }], "failed"],
    ["deferred tool", [creditsRequired, { ...terminalQuota, deferred_tool_use: { id: "read" } }], "failed"],
    ["successful retry", [creditsRequired, completed], "completed"],
    ["unresolved tool", [call("read", "Read", { file_path: "file.txt" }), creditsRequired, terminalQuota], "failed"],
    ["retry with repeated receipt", [creditsRequired, { type: "system", subtype: "api_retry" }, creditsRequired, terminalQuota], "failed"],
  ];
  for (const [name, frames, status] of cases) {
    await context.test(name, async (subtest) => {
      const { child, ...input } = await fixture(subtest, frames);
      const result = await observeClaudeFixtureTurn(child, input, () => undefined);
      assert.equal(result.status, status);
      assert.equal(result.quota, undefined);
    });
  }
});

test("Claude Code does not record a subscription refusal without a terminal result", async (context) => {
  const { child, ...input } = await fixture(context, [creditsRequired]);
  const views: ClaudeTurnObservation[] = [];
  await assert.rejects(observeClaudeFixtureTurn(child, input, (view) => views.push(view)), /without a confirmed result/);
  assert.equal(views.some(({ quota }) => quota !== undefined), false);
});
