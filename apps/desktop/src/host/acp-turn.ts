import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { normalize } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { safeLine, safeText } from "../../../tomverse-cli/src/display.js";
import type { TaskAnalysis } from "../../../tomverse-cli/src/task-plan.js";
import { patchSchema, readFileTool } from "../../../tomverse-cli/src/tools.js";
import { canonicalDigest } from "../../../tomverse-cli/src/session.js";
import { same, Workspace } from "../../../tomverse-cli/src/workspace.js";
import { acpUsageSources, kimiNativeSessionId, miniMaxNativeSessionId, MAX_CODE_PROMPT_CHARACTERS, type CodeNativeAssignment, type CodeNativeUsage,
  type CodeQuotaEvidence, type CodeTaskPlan } from "../contract";
import { initializeAcp, readCliFrames, type Frame } from "./cli-protocol";
import { antigravityModel, antigravityOptions, antigravityPatchFunction, antigravityPayload, antigravityPermission,
  antigravityReadFunction, antigravitySession, antigravityTaskListFunction, antigravityToolFrame } from "./antigravity-fixture";
import { grokFreeUsageError, grokPatchFunction, grokPermission, grokRateLimit, grokReadFunction, grokResult, grokSession, grokTodoInput, grokTodoResult,
  grokToolFrame, grokUseTool, grokWorkspaceInstruction, isGrokAdvisoryFrame } from "./grok-fixture";
import { hasCredential } from "./journal-view";
import { miniMaxFixtureModelSelection, miniMaxFixtureRoute, miniMaxFixtureVariant } from "./minimax-fixture";
import { qwenSubscriptionBaseUrl } from "./cli-fixture-input";
import type { NativePatchTool } from "./native-patches";
import { assertProjectRoot, type ProjectRoot } from "./project-root";
import { QwenUsage } from "./qwen-usage";
import { acpEdits, acpRpcId, kimiWriteInput } from "./acp-edits";
import { directMcpPatchFunction, directMcpReadFunction, nativeReadInput, nativeReadName, nativeTaskListInput, nativeTaskListName, startNativeMcpServer,
  vibePatchFunction, vibeReadFunction } from "./native-mcp-server";

import { completedNativeRow, maxNativePlanItems as maxPlanItems, nativeAnalysisInstruction, nativePlanPhase as phase,
  reconcileNativeRows, snapshotNativePlan, type NativeAnalysis as ActiveAnalysis, type NativePlanItem as PlanItem, type NativeRow as Row } from "./native-task-rows";

const shortId = z.string().regex(/^[\w.:-]{1,160}$/);
const plan = z.object({ entries: z.array(z.object({ content: z.string().trim().min(1).max(1600), status: phase,
  _meta: z.object({ qwenTodo: z.object({ id: z.string().regex(/^[\w.:-]{1,155}$/) }) }).optional() })).max(maxPlanItems) });
const callUpdate = z.object({ toolCallId: shortId, status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(),
  rawInput: z.object({ file_path: z.string().min(1).max(4096) }).optional().catch(undefined),
  _meta: z.object({ toolName: z.enum(["read_file", "write_file"]).optional() }).optional().catch(undefined) });
const qwenSession = z.object({
  sessionId: z.uuid().optional(), modes: z.object({ currentModeId: z.enum(["plan", "default"]) }),
  models: z.object({ currentModelId: z.string(), availableModels: z.tuple([z.object({ modelId: z.string(),
    _meta: z.discriminatedUnion("authType", [
      z.object({ authType: z.literal("openai"), baseModelId: shortId, baseUrl: z.url(), envKey: z.literal("OPENAI_API_KEY") }),
      z.object({ authType: z.literal("qwen-subscription"), baseModelId: shortId, baseUrl: z.literal(qwenSubscriptionBaseUrl), isRuntime: z.literal(false) }),
    ]),
  })]) }),
});
const kimiOptions = z.object({ configOptions: z.array(z.object({ id: z.string(), currentValue: z.unknown(),
  options: z.array(z.object({ value: z.string(), name: z.string() })) })).max(8) });
const kimiSession = kimiOptions.extend({ sessionId: kimiNativeSessionId.optional(),
  modes: z.object({ currentModeId: z.enum(["plan", "default"]) }) });
const mcpOptions = z.object({ configOptions: z.array(z.object({ id: z.string(), currentValue: z.unknown() })).max(12) });
const vibeSession = mcpOptions.extend({ sessionId: z.guid().optional(), modes: z.object({
  currentModeId: z.literal("ask"), availableModes: z.tuple([z.object({ id: z.literal("ask") })]),
}) });
const vibeTodos = z.object({ todos: z.array(z.object({ id: shortId.max(155), content: z.string().trim().min(1).max(1600),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]) })).max(maxPlanItems) });
const vibeEffect = callUpdate.pick({ toolCallId: true, status: true }).extend({
  rawInput: z.unknown().optional(), rawOutput: z.unknown().optional(),
  _meta: z.object({ tool_name: z.string(), effect_kind: z.string() }),
});
const vibeRetryNotice = z.object({
  sessionId: z.guid(),
  category: z.enum(["rate_limited", "server_error", "timed_out", "connection", "unknown"]),
  detail: z.string(),
});
const mcpEffect = callUpdate.pick({ toolCallId: true, status: true }).extend({
  title: z.string().max(160).optional(), rawInput: z.unknown().optional(),
});
const miniMaxSession = mcpOptions.extend({ sessionId: miniMaxNativeSessionId.optional(), modes: z.object({
  currentModeId: z.literal("default"),
}) });
const miniMaxTool = mcpEffect.extend({ rawOutput: z.unknown().optional() });
const miniMaxTodos = z.object({ todos: z.array(z.object({ content: z.string().trim().min(1).max(1600),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]), priority: z.enum(["low", "medium", "high"]),
})).max(maxPlanItems) });
const kimiArgsChunk = z.object({ content: z.tuple([z.object({ type: z.literal("content"),
  content: z.object({ type: z.literal("text"), text: z.string().max(256 * 1024) }) })]) });
const kimiStart = z.object({ title: z.enum(["Read", "Write"]), kind: z.enum(["read", "edit"]) });
const kimiPath = z.object({ path: z.string().max(4096) });
const readInput = z.object({ path: z.string().min(1).max(4096), line: z.int().min(1).max(10_000_000).nullish(),
  limit: z.int().min(1).max(10_000).nullish() });
const stop = z.object({ stopReason: z.enum(["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"]) });
const acpResultUsage = z.object({ usage: z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative().optional().catch(undefined),
}) });
const promptError = z.object({ code: z.int().negative(), message: z.string().min(1), data: z.unknown().optional() });
const qwenQuotaError = z.object({ code: z.literal(-32603), data: z.object({ subscriptionQuota: z.object({
  type: z.literal("subscription_quota"),
  resetAt: z.int().positive().max(253_402_300_799).optional().catch(undefined),
  requestId: z.string().regex(/^[\w.-]{1,128}$/).optional().catch(undefined),
}) }) });
const kimiFailedCompaction = [
  "Compacting conversation context…",
  "Compaction is blocked by the current turn; retry when the turn is idle.",
  "Compaction cancelled.",
].join("");
const miniMaxResult = z.object({ _meta: z.object({ "minimax-code/turn": z.object({ model: z.object({
  providerId: z.literal(miniMaxFixtureRoute), modelId: z.string(), variant: z.literal(miniMaxFixtureVariant),
  providerSource: z.literal("custom_provider"), protocol: z.literal("openai-completions"),
}) }) }) });
type Evidence = Row["evidence"][number];
type Call = { tool: "read_file" | "apply_patch"; evidence: Evidence; path?: string; read: boolean;
  proposed?: z.infer<typeof kimiWriteInput>; confirmed?: boolean; analysis?: ActiveAnalysis;
  mcp?: { input: unknown; digest: string; result?: boolean } };
type AcpTurnProgress = { session: CodeNativeAssignment; plan?: CodeTaskPlan; answer?: string;
  messages: Array<{ role: "user" | "assistant"; text: string }>; pendingFollowUp?: string; usage?: CodeNativeUsage };
export type AcpTurn = AcpTurnProgress & (
  { status?: "stopped" | "completed" | "failed" | "unknown"; quota?: never } |
  { status: "blocked"; quota: Extract<CodeQuotaEvidence, { source: "grok_build" | "qwen_code" }> }
);
type QueueFollowUp = (text: string) => Promise<boolean>;
type TurnInput = { project: ProjectRoot; protectedRoots: string[]; connectionKey: string; version: string; clientVersion: string;
  model: string; origin: string; prompt: string; mode: "ask" | "plan" | "agent"; signal: AbortSignal;
  previous?: { session: CodeNativeAssignment; plan?: CodeTaskPlan }; patchTool?: NativePatchTool;
  qwenSubscription?: boolean;
  beforeFollowUp?: () => void; provider: "qwen" | "moonshot" | "mistral" | "minimax" | "xai" | "google" };

export async function observeAcpTurn(child: { stdout: Readable; stdin: Writable }, input: TurnInput,
  publish: (turn: AcpTurn) => void, registerFollowUp?: (queue: QueueFollowUp) => void
): Promise<AcpTurn & { status: NonNullable<AcpTurn["status"]> }> {
  const incoming = readCliFrames(child.stdout, 2 * 1024 * 1024, { destroyOnReturn: false });
  const local = new AbortController();
  const signal = AbortSignal.any([local.signal, input.signal]);
  const workspace = new Workspace(input.project.path, input.protectedRoots);
  const kimi = input.provider === "moonshot";
  const vibe = input.provider === "mistral";
  const miniMax = input.provider === "minimax";
  const grok = input.provider === "xai";
  const antigravity = input.provider === "google";
  const usageSource = antigravity ? acpUsageSources.google : vibe ? acpUsageSources.mistral
    : miniMax ? acpUsageSources.minimax : grok ? acpUsageSources.xai : undefined;
  const planOnly = input.mode === "plan";
  const qwenSubscription = input.provider === "qwen" && input.qwenSubscription === true;
  const qwenUsage = input.provider === "qwen" ? new QwenUsage() : undefined;
  const usesMcp = vibe || miniMax || grok || antigravity;
  const requiresMcpGrant = grok || antigravity;
  const mcpReadName = antigravity ? antigravityReadFunction : grok ? grokReadFunction : vibe ? vibeReadFunction : directMcpReadFunction;
  const mcpPatchName = antigravity ? antigravityPatchFunction : grok ? grokPatchFunction : vibe ? vibePatchFunction : directMcpPatchFunction;
  const samePath = (first: string, second: string) => same(normalize(first), normalize(second));
  const send = (frame: Frame) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  const request = (id: number, method: string, params: Frame) => send({ id, method, params });
  const refuse = (id: z.infer<typeof acpRpcId>) => send({ id, error: { code: -32602, message: "Desktop did not authorize this action." } });
  const calls = new Map<string, Call>();
  const mcpCalls = new EventEmitter();
  const todoIds = new Set<string>();
  const miniMaxNames = new Map<string, string>();
  const miniMaxTodoDigests = new Map<string, string>();
  const grokTodoRequests = new Map<string, z.infer<typeof grokTodoInput>>();
  const mcpGranted = new Set<string>();
  const antigravityLists = new Map<string, { input: z.infer<typeof nativeTaskListInput>; digest: string; received?: boolean }>();
  const previousRows = input.previous?.plan?.items ?? [];
  const previousCallIds = new Set(previousRows.flatMap(({ evidence }) => evidence.map(({ nativeItemId }) => nativeItemId)));
  let activeAnalysis: ActiveAnalysis | undefined;
  let analysis: TaskAnalysis | undefined;
  let followUp: { text: string; resolve: (sent: boolean) => void } | undefined;
  let cancelRequested = false;
  const edits = acpEdits(workspace, input.patchTool, signal, (id, result) => send({ id, result }), refuse,
    (id) => {
      const call = calls.get(id);
      return !followUp && !!activeAnalysis && call?.tool === "apply_patch" && call.analysis === activeAnalysis && call.evidence.state === "running";
    },
    kimi ? (id) => calls.get(id)?.proposed : undefined);
  let rows = new Map(previousRows.map((row) => [row.id, row]));
  let planAccepted = false;
  let session: CodeNativeAssignment;
  const messages: AcpTurn["messages"] = [];
  let answer = "";
  let streaming = false;
  let promptId = 6;
  let grokLimitedPrompt: string | undefined;
  // Desktop presents Kimi and MiniMax plans from Todo updates with read-only workspace tools.
  const expectedMode = vibe ? "ask" : kimi || miniMax || input.mode === "agent" ? "default" : "plan";
  let modelId: string | undefined;
  let modeConfirmed = false;
  function checkKimiModel(options: z.infer<typeof kimiOptions>["configOptions"]) {
    const option = options.find(({ id }) => id === "model");
    return option?.currentValue === "local" && option.options.length === 1 &&
      option.options[0]?.value === "local" && option.options[0].name === input.model;
  }
  function checkMcpModel(options: z.infer<typeof mcpOptions>["configOptions"]) {
    const models = options.filter(({ id }) => id === "model");
    const expected = miniMax ? miniMaxFixtureModelSelection(input.model) : input.model;
    return models.length === 1 && models[0]?.currentValue === expected &&
      (!miniMax || options.find(({ id }) => id === "permissionMode")?.currentValue === "default");
  }
  const activeRow = () => {
    if (!planAccepted) return undefined;
    const active = [...rows.values()].filter((row) => !row.cancelled && row.nativeStatus === "in_progress" &&
      row.nativeAssignment?.turnId === session.turnId);
    return active.length === 1 ? active[0] : undefined;
  };
  const snapshot = (cancelled = false): AcpTurnProgress => ({
    session, answer: answer ? safeText(answer) : undefined,
    messages: [...messages], pendingFollowUp: followUp?.text,
    plan: snapshotNativePlan(rows, { activeId: streaming ? activeRow()?.id ?? null : null,
      analysis, streaming, stopped: cancelled, planOnly }),
  });
  const hasInFlightTools = () => edits.pending() || miniMaxTodoDigests.size > 0 || grokTodoRequests.size > 0 ||
    antigravityLists.size > 0 ||
    [...calls.values()].some(({ evidence }) => evidence.state === "running");
  const onCancel = () => {
    if (cancelRequested || !streaming) return;
    cancelRequested = true;
    send({ method: "session/cancel", params: { sessionId: session.threadId } });
  };
  const next = async () => {
    const result = await incoming.next();
    if (result.done || result.value.jsonrpc !== "2.0") throw new Error("The ACP connection closed or changed its protocol.");
    return result.value;
  };
  const rejectPlan = () => {
    planAccepted = false;
    activeAnalysis = undefined;
    publish(snapshot());
  };
  const updatePlan = (entries: PlanItem[]) => {
    const prefix = antigravity ? "antigravity" : grok ? "grok" : miniMax ? "minimax" : kimi ? "kimi" : vibe ? "vibe" : "qwen";
    const next = reconcileNativeRows(rows, entries, session, { prefix, titleKey: kimi || miniMax, planOnly });
    if (!next) {
      rejectPlan();
      return;
    }
    let { currentAnalysis } = next;
    rows = next.rows;
    planAccepted = true;
    if (activeRow()?.id !== currentAnalysis?.rowId) currentAnalysis = undefined;
    analysis = currentAnalysis?.summary ?? next.firstAnalysis ?? analysis;
    if (activeAnalysis?.rowId !== currentAnalysis?.rowId || activeAnalysis?.content !== currentAnalysis?.content) {
      activeAnalysis = currentAnalysis;
    }
    publish(snapshot());
  };
  const observeMcpFile = ({ toolCallId, status, rawInput }: z.infer<typeof mcpEffect>, name?: string) => {
    const call = calls.get(toolCallId);
    const read = name === mcpReadName;
    if (!call && !read && name !== mcpPatchName) return;
    if (!call && status === "in_progress" && !followUp && !signal.aborted) {
      const proposal = (read ? nativeReadInput : patchSchema).safeParse(rawInput);
      if (!proposal.success) return;
      if (calls.size >= 64) throw new Error("The ACP agent exceeded the turn's tool limit.");
      const tool = read ? "read_file" : "apply_patch";
      const row = activeRow();
      const evidence: Evidence = { tool, state: "running", assignment: session, nativeItemId: toolCallId };
      const analysis = read ? undefined : activeAnalysis;
      if (row && row.evidence.length < 64 && (read || analysis)) row.evidence.push(evidence);
      calls.set(toolCallId, { tool, evidence, read: false, analysis,
        mcp: { input: proposal.data, digest: canonicalDigest(proposal.data) } });
      mcpCalls.emit("proposal");
    } else if (call?.mcp && call.evidence.state === "running") {
      if (status === "in_progress" && rawInput != null && canonicalDigest(rawInput) !== call.mcp.digest) {
        call.evidence.state = "failed";
      }
      if (status === "failed") call.evidence.state = "failed";
      if (status === "completed") {
        if (call.mcp.result === undefined) throw new Error("The ACP agent reported a file operation without a Desktop outcome.");
        call.evidence.state = call.mcp.result ? "succeeded" : "failed";
      }
    }
    publish(snapshot());
  };
  const markTodo = (id: string) => {
    if (todoIds.size >= 64) throw new Error("The ACP agent exceeded the turn's task list update limit.");
    todoIds.add(id);
  };
  const observeGrokTool = (update: Record<string, unknown>) => {
    const parsed = grokToolFrame.safeParse(update);
    if (!parsed.success || previousCallIds.has(parsed.data.toolCallId)) return;
    const item = parsed.data;
    const name = item._meta?.["x.ai/tool"].name;
    const proposed = grokTodoRequests.get(item.toolCallId);
    if (proposed && (item.status === "completed" || item.status === "failed")) {
      grokTodoRequests.delete(item.toolCallId);
      if (item.status !== "completed" || followUp || signal.aborted) return;
      const result = grokTodoResult.safeParse(item.rawOutput);
      if (!result.success) return rejectPlan();
      const { todos, state } = result.data.TodosUpdated;
      const entries = Object.entries(state.todos);
      if (entries.length !== todos.length || (proposed.merge === false && entries.length !== proposed.todos.length) ||
          canonicalDigest(entries.map(([, row]) => row)) !== canonicalDigest(todos) ||
          proposed.todos.some(({ id, content, status }) => {
            const row = Object.hasOwn(state.todos, id) ? state.todos[id] : undefined;
            return !row || (content != null && row.content !== content) || (status != null && row.status !== status);
          })) return rejectPlan();
      updatePlan(entries.flatMap(([id, row]) => row.status === "cancelled" ? [] : [{ id, content: row.content, status: row.status }]));
      return;
    }
    if (name === "todo_write" && update.sessionUpdate === "tool_call" && !todoIds.has(item.toolCallId)) {
      markTodo(item.toolCallId);
      const request = grokTodoInput.safeParse(item.rawInput);
      if (request.success) grokTodoRequests.set(item.toolCallId, request.data);
      else rejectPlan();
      return;
    }
    const use = grokUseTool.safeParse(item.rawInput);
    if (name === "use_tool" && use.success && !item.status) {
      observeMcpFile({ toolCallId: item.toolCallId, status: "in_progress", rawInput: use.data.tool_input }, use.data.tool_name);
    } else if (item.status === "completed" || item.status === "failed") {
      observeMcpFile({ toolCallId: item.toolCallId, status: item.status });
    }
  };
  const observeMcpEffect = (update: Record<string, unknown>) => {
    if (grok) return observeGrokTool(update);
    if (antigravity) {
      const parsed = antigravityToolFrame.safeParse(update);
      if (!parsed.success || previousCallIds.has(parsed.data.toolCallId)) return;
      const { toolCallId, name, status, rawInput } = parsed.data;
      const args = antigravityPayload(rawInput);
      if (name === antigravityTaskListFunction) {
        if (input.mode === "ask" || followUp || signal.aborted) {
          if (status === "completed" || status === "failed") antigravityLists.delete(toolCallId);
          return;
        }
        if (update.sessionUpdate === "tool_call" && status === "in_progress" && !todoIds.has(toolCallId)) {
          markTodo(toolCallId);
          const list = nativeTaskListInput.safeParse(args);
          if (list.success) antigravityLists.set(toolCallId, { input: list.data, digest: canonicalDigest(list.data) });
          else rejectPlan();
        } else if (status === "completed" || status === "failed") {
          const list = antigravityLists.get(toolCallId);
          antigravityLists.delete(toolCallId);
          if (!list) return;
          if (status === "completed" && list.received) updatePlan(list.input.items);
          else rejectPlan();
        }
        return;
      }
      if (name !== mcpReadName && name !== mcpPatchName) return;
      if (rawInput !== undefined && !args) throw new Error("Antigravity changed its file tool input.");
      observeMcpFile({ toolCallId, status, rawInput: args }, name);
      return;
    }
    if (miniMax) {
      const parsed = miniMaxTool.safeParse(update);
      if (!parsed.success || previousCallIds.has(parsed.data.toolCallId)) return;
      const item = parsed.data;
      if (update.sessionUpdate === "tool_call" &&
          (item.title === mcpReadName || item.title === mcpPatchName || item.title === "todowrite")) {
        if (miniMaxNames.size >= 64 || miniMaxNames.has(item.toolCallId)) throw new Error("MiniMax Code repeated or exceeded its tool call range.");
        miniMaxNames.set(item.toolCallId, item.title);
      }
      const name = miniMaxNames.get(item.toolCallId);
      if (name !== "todowrite") {
        observeMcpFile(item, name);
        return;
      }
      if (item.status === "in_progress" && !todoIds.has(item.toolCallId)) {
        markTodo(item.toolCallId);
        const proposed = miniMaxTodos.safeParse(item.rawInput);
        if (proposed.success) miniMaxTodoDigests.set(item.toolCallId, canonicalDigest(proposed.data));
        else rejectPlan();
      } else if (item.status === "completed" || item.status === "failed") {
        const digest = miniMaxTodoDigests.get(item.toolCallId);
        miniMaxTodoDigests.delete(item.toolCallId);
        if (!digest || item.status !== "completed" || followUp || signal.aborted) return;
        const output = z.object({ details: miniMaxTodos }).safeParse(item.rawOutput);
        if (output.success && canonicalDigest(output.data.details) === digest) {
          updatePlan(output.data.details.todos.flatMap(({ content, status }) => status === "cancelled" ? [] : [{ content, status }]));
        } else rejectPlan();
      }
      return;
    }
    const parsed = vibeEffect.safeParse(update);
    if (!parsed.success || previousCallIds.has(parsed.data.toolCallId)) return;
    const { toolCallId, status, rawOutput, _meta } = parsed.data;
    if (_meta.effect_kind === "todo" && status === "completed" && !followUp && !signal.aborted && !todoIds.has(toolCallId)) {
      markTodo(toolCallId);
      const output = vibeTodos.safeParse(rawOutput);
      if (output.success) updatePlan(output.data.todos.flatMap(({ id, content, status }) =>
        status === "cancelled" ? [] : [{ id, content, status }]));
      else rejectPlan();
      return;
    }
    observeMcpFile(parsed.data, _meta.tool_name);
  };
  const notification = (frame: Frame) => {
    if (vibe && frame.method === "_session/retrying") {
      vibeRetryNotice.extend({ sessionId: z.literal(session.threadId) }).parse(frame.params);
      return;
    }
    if (grok && isGrokAdvisoryFrame(frame.method, frame.params, session.threadId)) {
      if (streaming && frame.method === "_x.ai/session/prompt_complete") {
        const limit = grokRateLimit.safeParse(frame.params);
        grokLimitedPrompt = limit.success ? limit.data.promptId : undefined;
      }
      return;
    }
    if (!kimi && !usesMcp && (frame.method === "qwen/notify/session/last-user-prompt" || frame.method === "qwen/notify/session/title-update" ||
        frame.method === "qwen/notify/session/sources-changed" || frame.method === "qwen/notify/session/goal-changed")) {
      z.object({ sessionId: z.literal(session.threadId) }).parse(frame.params);
      return;
    }
    if (!kimi && !usesMcp && (frame.method === "qwen/notify/session/model-update" || frame.method === "qwen/notify/session/mode-update")) {
      const scope = z.object({ sessionId: z.literal(session.threadId), currentModelId: z.string().optional(),
        currentModeId: z.string().optional() }).parse(frame.params);
      if (frame.method.endsWith("/model-update") ? scope.currentModelId !== modelId : scope.currentModeId !== expectedMode) {
        throw new Error("The ACP agent changed the approved session configuration.");
      }
      return;
    }
    if (frame.method !== "session/update") throw new Error(`Unexpected ACP notification: ${safeLine(String(frame.method)).slice(0, 100)}.`);
    const { update } = z.object({ sessionId: z.literal(session.threadId), update: z.record(z.string(), z.unknown()) }).parse(frame.params);
    if (update.sessionUpdate === "current_mode_update" || update.sessionUpdate === "config_option_update") {
      if (usesMcp) {
        const unchanged = update.sessionUpdate === "current_mode_update" ?
          (vibe || miniMax || antigravity) && update.currentModeId === (antigravity ? "default" : expectedMode) :
          (antigravity ? antigravityOptions : checkMcpModel)(mcpOptions.parse(update).configOptions);
        if (!unchanged) throw new Error("The ACP agent changed the approved session configuration.");
        return;
      }
      if (!kimi) throw new Error("The ACP agent changed the approved session configuration.");
      if (update.sessionUpdate === "current_mode_update") {
        if (update.currentModeId !== expectedMode) throw new Error("Kimi Code changed the approved session mode.");
        modeConfirmed = true;
      } else {
        const { configOptions } = kimiOptions.parse(update);
        if (!checkKimiModel(configOptions) || configOptions.find(({ id }) => id === "mode")?.currentValue !== expectedMode) {
          throw new Error("Kimi Code changed the approved session configuration.");
        }
      }
      return;
    }
    if (!streaming) return;
    qwenUsage?.observe(update, session.threadId, input.model, modelId);
    if (update.sessionUpdate === "agent_message_chunk") {
      const content = z.object({ type: z.literal("text"), text: z.string() }).safeParse(update.content);
      if (content.success && !signal.aborted) answer += content.data.text.slice(0, Math.max(0, 24_000 - answer.length));
      publish(snapshot());
    } else if (update.sessionUpdate === "plan") {
      if (usesMcp || followUp) return;
      const parsed = plan.safeParse(update);
      if (!parsed.success) {
        rejectPlan();
        return;
      }
      updatePlan(parsed.data.entries.map(({ content, status, _meta }) => ({ content, status, id: _meta?.qwenTodo.id })));
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      if (usesMcp) {
        observeMcpEffect(update);
        return;
      }
      const parsed = callUpdate.safeParse(update);
      if (!parsed.success || previousCallIds.has(parsed.data.toolCallId)) return;
      const item = parsed.data;
      let call = calls.get(item.toolCallId);
      const nativeStart = kimi ? kimiStart.safeParse(update) : undefined;
      const name = nativeStart?.success ? nativeStart.data.title === "Read" ? "read_file" : "write_file" : item._meta?.toolName;
      if (!call && name && (item.status === "pending" || (kimi && item.status === "in_progress"))) {
        if (calls.size >= 64) throw new Error("The ACP agent exceeded the turn's tool limit.");
        const tool = name === "read_file" ? "read_file" : "apply_patch";
        const row = activeRow();
        const analysis = tool === "apply_patch" ? activeAnalysis : undefined;
        const evidence: Evidence = { tool, state: "running", assignment: session, nativeItemId: item.toolCallId };
        if (row && row.evidence.length < 64 && (tool === "read_file" || analysis)) row.evidence.push(evidence);
        call = { tool, evidence, read: false, analysis };
        calls.set(item.toolCallId, call);
      }
      if (call?.evidence.state === "running") {
        if (kimi) {
          const receivedPath = kimiPath.safeParse(update.rawInput);
          if (receivedPath.success) call.path ??= receivedPath.data.path;
          if (call.tool === "apply_patch" && update.rawInput === undefined && !call.confirmed) {
            const chunk = kimiArgsChunk.safeParse(update);
            if (chunk.success) {
              try {
                const args = kimiWriteInput.safeParse(JSON.parse(chunk.data.content[0].content.text));
                call.proposed = args.success ? args.data : undefined;
              } catch {
                call.proposed = undefined;
              }
            }
          } else if (call.tool === "apply_patch" && update.rawInput !== undefined) {
            const current = kimiWriteInput.safeParse(update.rawInput);
            call.confirmed = current.success && !!call.proposed && samePath(current.data.path, call.proposed.path) &&
              current.data.content === call.proposed.content;
          }
        } else call.path ??= item.rawInput?.file_path;
        if (item.status === "failed") call.evidence.state = "failed";
        if (item.status === "completed") {
          const verified = call.tool === "read_file" ? call.read : edits.written(item.toolCallId);
          if (!verified) throw new Error("The ACP agent reported a tool result without a confirmed Desktop operation.");
          call.evidence.state = "succeeded";
        }
        publish(snapshot());
      }
    }
  };
  const readWorkspace = (args: z.infer<typeof nativeReadInput>) => {
    assertProjectRoot(input.project);
    signal.throwIfAborted();
    const result = readFileTool({ workspace, readByteLimit: 256 * 1024 }, args);
    if (result.status !== "ok" || typeof result.text !== "string" || hasCredential(result.text, input.connectionKey)) {
      throw new Error("The file could not be read.");
    }
    return result.text;
  };
  const read = (id: z.infer<typeof acpRpcId>, params: unknown) => {
    try {
      const { path, line, limit } = readInput.parse(params);
      const startLine = line ?? 1;
      const content = readWorkspace({ path, startLine, endLine: limit ? startLine + limit - 1 : undefined });
      const candidates = [...calls.values()].filter((call) => call.tool === "read_file" && call.path &&
        call.evidence.state === "running" && samePath(call.path, path));
      if (candidates.length === 1) candidates[0]!.read = true;
      send({ id, result: { content } });
    } catch {
      if (kimi) send({ id, error: { code: -32002, message: "The file is unavailable in the Desktop workspace." } });
      else refuse(id);
    }
  };
  let mcpServer: Awaited<ReturnType<typeof startNativeMcpServer>> | undefined;
  try {
    if (usesMcp) mcpServer = await startNativeMcpServer({
      patch: input.patchTool,
      acceptTaskList: antigravity && input.mode !== "ask" ? (id) => {
        const proposal = antigravityLists.get(id);
        if (proposal) proposal.received = true;
      } : undefined,
      read: (id, args, requestSignal) => {
        const call = calls.get(id)?.mcp;
        if (!call) throw new Error("The ACP agent did not propose this read.");
        call.result = false;
        requestSignal.throwIfAborted();
        const text = readWorkspace(args);
        call.result = true;
        return text;
      },
      onPatchResult: (id, success) => {
        const call = calls.get(id)?.mcp;
        if (call) call.result = success;
      },
    }, signal, async (args, requestSignal, name) => {
      const digest = canonicalDigest(args);
      if (name === nativeTaskListName) {
        const current = [...antigravityLists.entries()].filter(([id, proposal]) => !proposal.received &&
          proposal.digest === digest && mcpGranted.has(id));
        if (current.length !== 1) return;
        const [id, proposal] = current[0]!;
        return { id, input: proposal.input, canApply: () => streaming && !followUp && !signal.aborted &&
          antigravityLists.get(id) === proposal && !proposal.received };
      }
      const tool = name === nativeReadName ? "read_file" : "apply_patch";
      const wait = AbortSignal.any([requestSignal, AbortSignal.timeout(5_000)]);
      while (streaming && !followUp && !wait.aborted) {
        const matches = [...calls.entries()].filter(([, call]) => call.tool === tool && call.mcp?.digest === digest &&
          call.evidence.state === "running");
        if (matches.length > 1) return;
        if (matches.length === 1) {
          const [id, call] = matches[0]!;
          return { id, input: call.mcp!.input, canApply: () => streaming && !followUp && !signal.aborted &&
            call.evidence.state === "running" && (!requiresMcpGrant || mcpGranted.has(id)) &&
            (tool === "read_file" || !!activeAnalysis && call.analysis === activeAnalysis &&
              [...calls.values()].some(({ tool, evidence }) => tool === "read_file" && evidence.state === "succeeded")) };
        }
        await once(mcpCalls, "proposal", { signal: wait });
      }
    });
    const initialize = await initializeAcp({ send, read: async (matches) => {
      const frame = await next();
      if (!matches(frame) || frame.error || frame.method) throw new Error("Unexpected ACP initialization response.");
      return frame;
    } }, input.provider, { client: input.clientVersion, executable: input.version }, usesMcp ? {} : {
      fs: { readTextFile: true, ...(input.patchTool && { writeTextFile: true }) },
    });
    if (vibe && (initialize.authMethods?.length !== 0 || input.previous && initialize.agentCapabilities?.loadSession !== true)) {
      throw new Error("Vibe changed its isolated session capabilities.");
    }
    if (miniMax && ((initialize.authMethods?.length ?? 0) !== 0 || initialize.agentCapabilities?.mcpCapabilities?.http !== true ||
        !initialize.agentCapabilities.sessionCapabilities?.close || input.previous && initialize.agentCapabilities.loadSession !== true)) {
      throw new Error("MiniMax Code changed its isolated session capabilities.");
    }
    if (grok && (!initialize.authMethods?.some(({ id }) => id === "xai.api_key") ||
        initialize.agentCapabilities?.mcpCapabilities?.http !== true || !initialize.agentCapabilities.sessionCapabilities?.close ||
        input.previous && initialize.agentCapabilities.loadSession !== true)) {
      throw new Error("Grok Build changed its isolated session capabilities.");
    }
    if (antigravity && (!initialize.authMethods?.some(({ id }) => id === "gemini-api-key") ||
        initialize.agentCapabilities?.mcpCapabilities?.http !== true ||
        !initialize.agentCapabilities.sessionCapabilities?.resume || !initialize.agentCapabilities.sessionCapabilities.close)) {
      throw new Error("Antigravity changed its isolated session capabilities.");
    }
    if (!kimi && !usesMcp) {
      if (input.previous && initialize.agentCapabilities?.loadSession !== true) throw new Error("Qwen Code cannot load the saved session.");
      if (initialize.authMethods?.length !== 1 || initialize.authMethods[0]?.id !== "openai") {
        throw new Error("The Qwen Code loopback authentication method changed.");
      }
    }
    const authMethod = antigravity && !input.previous ? "gemini-api-key" : !kimi && !usesMcp && !qwenSubscription ? "openai" : undefined;
    if (authMethod) {
      signal.throwIfAborted();
      request(2, "authenticate", { methodId: authMethod });
      const auth = await next();
      if (auth.id !== 2 || auth.method || auth.error || !auth.result) throw new Error("The ACP loopback profile was not authenticated.");
    }
    signal.throwIfAborted();
    const previous = input.previous;
    if (previous) session = { ...previous.session, turnId: randomUUID() };
    request(3, previous ? (kimi || antigravity ? "session/resume" : "session/load") : "session/new", {
      cwd: input.project.path, mcpServers: mcpServer ? [mcpServer.descriptor] : [],
      ...(previous && { sessionId: previous.session.threadId }) });
    let ready: unknown;
    let startupThreadId = previous?.session.threadId;
    for (;;) {
      const frame = await next();
      if (frame.id === 3 && !frame.error && !frame.method) {
        ready = frame.result;
        break;
      }
      if (grok && !Object.hasOwn(frame, "id") && isGrokAdvisoryFrame(frame.method, frame.params, startupThreadId)) continue;
      if ((!previous && !vibe && !miniMax && !grok && !antigravity) || Object.hasOwn(frame, "id") || frame.method !== "session/update") {
        throw new Error("Unexpected ACP session startup frame.");
      }
      if (vibe || miniMax || grok || antigravity) {
        const startup = z.object({ sessionId: miniMax ? miniMaxNativeSessionId : z.guid(), update: z.record(z.string(), z.unknown()) }).parse(frame.params);
        startupThreadId ??= startup.sessionId;
        if (startupThreadId !== startup.sessionId) throw new Error("The ACP agent changed the session ID during startup.");
      } else notification(frame);
    }
    let threadId: string;
    let switchMode = false;
    if (antigravity) {
      const state = antigravitySession.parse(ready);
      threadId = state.sessionId;
      if (input.model !== antigravityModel || !antigravityOptions(state.configOptions) || startupThreadId && startupThreadId !== threadId) {
        throw new Error("Antigravity did not confirm the scoped session and model.");
      }
    } else if (vibe) {
      const state = vibeSession.parse(ready);
      threadId = z.guid().parse(state.sessionId ?? previous?.session.threadId);
      if (!checkMcpModel(state.configOptions) || (startupThreadId && startupThreadId !== threadId)) {
        throw new Error("Vibe did not confirm the scoped model and session.");
      }
    } else if (miniMax) {
      const state = miniMaxSession.parse(ready);
      threadId = miniMaxNativeSessionId.parse(state.sessionId ?? previous?.session.threadId);
      if (!checkMcpModel(state.configOptions) || startupThreadId && startupThreadId !== threadId) {
        throw new Error("MiniMax Code did not confirm the scoped model and session.");
      }
    } else if (grok) {
      const state = grokSession.parse(ready);
      const detail = state._meta["x.ai/sessionDetail"];
      threadId = z.uuid().parse(state.sessionId ?? previous?.session.threadId);
      if (state.models.currentModelId !== input.model || detail.currentModelId !== input.model ||
          detail.sessionId !== threadId || !samePath(detail.cwd, input.project.path) ||
          startupThreadId && startupThreadId !== threadId) {
        throw new Error("Grok Build did not confirm the scoped model and workspace.");
      }
    } else if (kimi) {
      const state = kimiSession.parse(ready);
      threadId = kimiNativeSessionId.parse(state.sessionId ?? previous?.session.threadId);
      if (!checkKimiModel(state.configOptions) ||
          state.configOptions.find(({ id }) => id === "mode")?.currentValue !== state.modes.currentModeId) {
        throw new Error("The Kimi Code session configuration changed.");
      }
      switchMode = state.modes.currentModeId !== expectedMode;
    } else {
      const state = qwenSession.parse(ready);
      threadId = z.uuid().parse(state.sessionId ?? previous?.session.threadId);
      const [model] = state.models.availableModels;
      if (state.models.currentModelId !== model.modelId || model._meta.baseModelId !== input.model ||
          model._meta.authType !== (qwenSubscription ? "qwen-subscription" : "openai") ||
          (!qwenSubscription && model._meta.baseUrl !== `${input.origin}/v1`) || state.modes.currentModeId !== expectedMode) {
        throw new Error("The Qwen Code session configuration changed.");
      }
      modelId = model.modelId;
    }
    if (previous && previous.session.threadId !== threadId) throw new Error("The ACP agent changed the saved session ID.");
    session = { provider: input.provider, model: input.model, threadId, turnId: previous ? session!.turnId : randomUUID() };
    const acknowledge = async (id: number) => {
      for (;;) {
        const frame = await next();
        if (frame.id === id && !frame.method && !frame.error && z.object({}).safeParse(frame.result).success) return;
        if (Object.hasOwn(frame, "id")) throw new Error("Unexpected ACP response.");
        notification(frame);
      }
    };
    if (switchMode) {
      request(5, "session/set_mode", { sessionId: threadId, modeId: expectedMode });
      await acknowledge(5);
      if (!modeConfirmed) throw new Error("Kimi Code did not confirm the approved session mode.");
    }
    const startPrompt = (text: string) => {
      signal.throwIfAborted();
      assertProjectRoot(input.project);
      const analysisInstruction = nativeAnalysisInstruction(session.turnId);
      const editInstruction = "A simple answer does not need a task list. Before proposing an edit, publish the analysis in the active work item as described and mark the row in_progress. Keep the row active until the file operation returns. Publish fresh analysis after resuming or receiving a new instruction. Every edit needs Desktop approval.";
      const instruction = input.mode === "agent" ? `${analysisInstruction} ${editInstruction}` :
        planOnly ? `${analysisInstruction} Publish the ordered task list with pending items and stop before implementation.` : undefined;
      const workspaceInstruction = antigravity ? `Use ${antigravityReadFunction} to inspect files in this workspace. ` +
        (input.mode === "ask" ? "" : `Publish and update task items with ${antigravityTaskListFunction}. `) +
        (input.mode === "agent" ? `Submit file edits only through ${antigravityPatchFunction} after confirming a workspace read. ` : "") :
        grok ? grokWorkspaceInstruction(input.mode === "agent") :
        usesMcp ? `Use ${vibe ? nativeReadName : mcpReadName} to inspect files in this workspace. ` +
        `Use the ${miniMax ? "todowrite" : "todo"} tool for task updates. ` +
        (input.mode === "agent" ? `Submit file edits only through ${vibe ? "desktop_apply_patch" : mcpPatchName} after confirming a workspace read. ` : "") : "";
      const prompt = instruction || workspaceInstruction ? `${text}\n\nDesktop instructions:\n${workspaceInstruction}${instruction ?? ""}` : text;
      streaming = true;
      cancelRequested = false;
      grokLimitedPrompt = undefined;
      qwenUsage?.startPrompt();
      request(++promptId, "session/prompt", { sessionId: threadId, prompt: [{ type: "text", text: prompt }] });
      publish(snapshot());
    };
    registerFollowUp?.((text) => {
      const trimmed = text.trim();
      if (!streaming || signal.aborted || followUp || edits.pending() || !trimmed ||
          (usesMcp && [...calls.values()].some(({ tool, evidence }) => tool === "apply_patch" && evidence.state === "running")) ||
          trimmed.length > MAX_CODE_PROMPT_CHARACTERS || /^[\/!]/.test(trimmed) || hasCredential(trimmed, input.connectionKey)) {
        return Promise.resolve(false);
      }
      return new Promise((resolve) => {
        followUp = { text: trimmed, resolve };
        publish(snapshot());
        if (!hasInFlightTools()) onCancel();
      });
    });
    startPrompt(input.prompt);
    input.signal.addEventListener("abort", onCancel, { once: true });
    for (;;) {
      const frame = await next();
      if (frame.id === promptId && !frame.method) {
        const failure = Object.hasOwn(frame, "error") ? promptError.parse(frame.error) : undefined;
        if (failure && Object.hasOwn(frame, "result")) throw new Error("ACP returned an ambiguous prompt outcome.");
        const stopReason = failure ? "error" : stop.parse(frame.result).stopReason;
        if (miniMax && stopReason === "end_turn" &&
            miniMaxResult.parse(frame.result)._meta["minimax-code/turn"].model.modelId !== input.model) {
          throw new Error("MiniMax Code returned a different execution model.");
        }
        const grokCompletion = grok && stopReason === "end_turn" ? grokResult.parse(frame.result)._meta : undefined;
        if (grokCompletion && (grokCompletion.sessionId !== threadId || grokCompletion.modelId !== input.model)) {
          throw new Error("Grok Build returned a different session or execution model.");
        }
        // Vibe reports session totals on terminal responses, including cancellation.
        const tokens = grok ? grokCompletion?.usage : usageSource && (stopReason === "end_turn" || vibe && !failure)
          ? acpResultUsage.safeParse(frame.result).data?.usage : undefined;
        if (antigravity && stopReason === "end_turn" && !tokens?.inputTokens) {
          throw new Error("Antigravity did not confirm input usage.");
        }
        const usage = qwenUsage?.result() ?? (
          usageSource && tokens?.outputTokens !== undefined && (tokens.inputTokens > 0 || tokens.outputTokens > 0)
            ? { source: usageSource, inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens } : undefined);
        if (hasInFlightTools()) {
          throw new Error("The ACP agent stopped before confirming the outcome of its tools.");
        }
        const unconfirmedTurn = (kimi || miniMax || vibe) && stopReason === "end_turn" &&
          (!answer.trim() || kimi && answer === kimiFailedCompaction) &&
          !(planAccepted && rows.size) && ![...calls.values()].some(({ evidence }) => evidence.state === "succeeded");
        const exhaustedPrompt = grok && !signal.aborted && !followUp && grokLimitedPrompt &&
          grokFreeUsageError.safeParse(failure).success ? grokLimitedPrompt : undefined;
        const qwenQuota = qwenSubscription && !signal.aborted && !followUp ? qwenQuotaError.safeParse(failure).data?.data.subscriptionQuota : undefined;
        streaming = false;
        if (answer.trim()) messages.push({ role: "assistant", text: safeText(answer) });
        answer = "";
        if (followUp && !signal.aborted && !unconfirmedTurn &&
            (stopReason === "end_turn" || stopReason === "cancelled" && cancelRequested)) {
          if (usage) publish({ ...snapshot(), usage });
          input.beforeFollowUp?.();
          const instruction = followUp;
          for (const id of calls.keys()) previousCallIds.add(id);
          for (const id of todoIds) previousCallIds.add(id);
          for (const id of miniMaxNames.keys()) previousCallIds.add(id);
          calls.clear();
          todoIds.clear();
          miniMaxNames.clear();
          mcpGranted.clear();
          for (const [id, row] of rows) {
            if (row.cancelled || (!planOnly && completedNativeRow(row))) continue;
            rows.set(id, { ...row, nativeStatus: "pending", evidenceStart: row.evidence.length, nativeAssignment: undefined });
          }
          session = { ...session, turnId: randomUUID() };
          planAccepted = false;
          activeAnalysis = undefined;
          analysis = undefined;
          messages.push({ role: "user", text: instruction.text });
          followUp = undefined;
          try {
            startPrompt(instruction.text);
            instruction.resolve(true);
          } catch (error) {
            instruction.resolve(false);
            throw error;
          }
          continue;
        }
        followUp?.resolve(false);
        followUp = undefined;
        if (kimi || usesMcp) {
          request(6, "session/close", { sessionId: threadId });
          await acknowledge(6);
        }
        if (exhaustedPrompt && !signal.aborted) return { ...snapshot(), status: "blocked" as const,
          quota: { source: "grok_build" as const, reason: "grokFreeUsageExhausted" as const, threadId, turnId: session.turnId,
            promptId: exhaustedPrompt } };
        if (qwenQuota && !signal.aborted) return { ...snapshot(), ...(usage && { usage }), status: "blocked" as const,
          quota: { source: "qwen_code" as const, reason: "qwenSubscriptionUsageExhausted" as const, threadId, turnId: session.turnId,
            ...(qwenQuota.requestId && { requestId: qwenQuota.requestId }),
            ...(qwenQuota.resetAt && { resetAt: new Date(qwenQuota.resetAt * 1000).toISOString() }),
          } };
        if (unconfirmedTurn) return { ...snapshot(), ...(usage && { usage }), status: "unknown" as const };
        const stopped = stopReason === "cancelled" && signal.aborted;
        return { ...snapshot(stopped), ...(usage && { usage }), status: stopped ? "stopped" as const :
          stopReason === "end_turn" && !signal.aborted ? "completed" as const : "failed" as const };
      }
      if (typeof frame.method !== "string") throw new Error("Unexpected ACP response.");
      if (!Object.hasOwn(frame, "id")) {
        notification(frame);
        if (followUp && !hasInFlightTools()) onCancel();
        continue;
      }
      const id = acpRpcId.parse(frame.id);
      z.object({ sessionId: z.literal(threadId) }).parse(frame.params);
      if (usesMcp) {
        if (frame.method === "session/request_permission") {
          const agyPermission = antigravity ? antigravityPermission.safeParse(frame.params) : undefined;
          const permission = grok ? grokPermission.safeParse(frame.params) : undefined;
          if (!followUp && streaming && !signal.aborted && (agyPermission?.success || permission?.success)) {
            const request = agyPermission?.success ? agyPermission.data : permission?.data;
            if (!request) throw new Error("The ACP permission request could not be validated.");
            const agyCall = agyPermission?.success ? agyPermission.data.toolCall : undefined;
            const grokCall = permission?.success ? permission.data.toolCall : undefined;
            const toolId = request.toolCall.toolCallId;
            const name = agyCall?.name ?? grokCall?.rawInput.tool_name;
            const rawInput = agyCall ? antigravityPayload(agyCall.rawInput) : grokCall?.rawInput.tool_input;
            const option = request.options.filter(({ kind }) => kind === "allow_once");
            const call = calls.get(toolId);
            const taskList = antigravityLists.get(toolId);
            const read = name === mcpReadName;
            const digest = rawInput === undefined ? undefined : canonicalDigest(rawInput);
            const authorizedTool = (read || name === mcpPatchName) && call?.evidence.state === "running" &&
              call.tool === (read ? "read_file" : "apply_patch") && call.mcp?.digest === digest &&
              (read || !!activeAnalysis && call.analysis === activeAnalysis && !!input.patchTool);
            const authorizedList = name === antigravityTaskListFunction && taskList &&
              taskList.digest === digest && !taskList.received;
            // This allows transport to the Desktop MCP server. File writes still require Desktop approval.
            if (option.length === 1 && !mcpGranted.has(toolId) && digest !== undefined &&
                (!grokCall || grokCall._meta["x.ai/requestingSessionId"] === threadId) && (authorizedTool || authorizedList)) {
              mcpGranted.add(toolId);
              send({ id, result: { outcome: { outcome: "selected", optionId: option[0]!.optionId } } });
              continue;
            }
          }
          send({ id, result: { outcome: { outcome: "cancelled" } } });
        }
        else refuse(id);
      }
      else if (frame.method === "fs/read_text_file") read(id, frame.params);
      else if (frame.method === "session/request_permission") {
        if (followUp) send({ id, result: { outcome: { outcome: "cancelled" } } });
        else edits.permission(id, frame.params);
      }
      else if (frame.method === "fs/write_text_file") {
        const actual = kimiWriteInput.strip().safeParse(frame.params);
        const confirmed = !kimi || (actual.success && [...calls.values()].some(({ confirmed, evidence, proposed }) =>
          confirmed && evidence.state === "running" && proposed &&
          samePath(proposed.path, actual.data.path) && proposed.content === actual.data.content));
        edits.write(id, confirmed ? frame.params : undefined);
      }
      else refuse(id);
    }
  } finally {
    followUp?.resolve(false);
    input.signal.removeEventListener("abort", onCancel);
    local.abort();
    // The runner drains stdout and waits for the child to close after the terminal reply.
    await incoming.return(undefined);
    await mcpServer?.close();
    await edits.close();
  }
}
