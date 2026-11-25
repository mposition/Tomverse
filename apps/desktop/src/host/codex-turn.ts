import { createHash } from "node:crypto";
import { normalize } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { safeLine, safeText } from "../../../tomverse-cli/src/display.js";
import { parseTaskAnalysis, type TaskAnalysis } from "../../../tomverse-cli/src/task-plan.js";
import type { CodeNativeAssignment, CodeNativeUsage } from "../contract";
import { initializeCodex, readCliFrames, verifyCodexLoopbackDestination, type Frame } from "./cli-protocol";
import type { CodexWorkspace } from "./codex-workspace";

export const codexFixtureProvider = "tomverse_fixture";

const id = z.string().min(1).max(160).regex(/^[\w.:-]+$/);
const modelId = z.string().min(1).max(160).regex(/^[\w.:-]+$/);
const binding = z.object({ threadId: id, turnId: id });
const nativeStep = z.object({ step: z.string().trim().min(1).max(160), status: z.enum(["pending", "inProgress", "completed"]) });
const planUpdate = binding.extend({ explanation: z.unknown().optional(), plan: z.array(nativeStep).max(12) }).refine(({ plan }) =>
  new Set(plan.map(({ step }) => step)).size === plan.length && plan.filter(({ status }) => status === "inProgress").length <= 1);
const threadIdentity = z.object({ id, ephemeral: z.boolean(), cwd: z.string() });
const storedThread = z.object({ thread: threadIdentity.extend({
  ephemeral: z.literal(false), modelProvider: z.literal(codexFixtureProvider), status: z.object({ type: z.enum(["notLoaded", "idle"]) }),
}) });
const latestTurn = z.object({ data: z.tuple([z.object({ id, status: z.enum(["inProgress", "completed", "interrupted", "failed"]) })]) });
const recordedItems = z.object({
  nextCursor: z.null().optional(), data: z.array(z.object({
    item: z.object({ id, type: z.string() }).passthrough(),
    turnId: id,
    completedAtMs: z.number().int().positive().nullable().optional(),
  })).max(64),
});
const threadResponse = z.object({
  cwd: z.string(), model: modelId, modelProvider: z.literal(codexFixtureProvider), reasoningEffort: z.string().max(24).nullable().optional(),
  approvalPolicy: z.literal("never"), sandbox: z.object({ type: z.literal("readOnly"), networkAccess: z.literal(false).optional() }),
  thread: threadIdentity,
});
const turnResponse = z.object({ turn: z.object({ id, status: z.literal("inProgress") }) });
const turnEnd = z.object({ threadId: id, turn: z.object({ id, status: z.enum(["completed", "interrupted", "failed"]),
  error: z.object({ codexErrorInfo: z.unknown().optional() }).nullish() }) });
const itemUpdate = binding.extend({ item: z.object({ id, type: z.string() }).passthrough() });
const commandItem = z.object({
  command: z.string().min(1).max(4096), cwd: z.string(), source: z.enum(["agent", "unifiedExecStartup"]).optional(),
  status: z.enum(["inProgress", "completed", "failed", "declined"]), exitCode: z.number().int().nullable().optional(),
  commandActions: z.array(z.object({ type: z.enum(["read", "listFiles", "search", "unknown"]) })).max(16),
});
const publicMessage = z.object({ text: z.string() });
const publicDelta = binding.extend({ itemId: id, delta: z.string().min(1) });
const rerouted = binding.extend({ fromModel: modelId, toModel: modelId });
const tokenUsage = binding.extend({ tokenUsage: z.object({ total: z.object({ totalTokens: z.int().nonnegative() }) }) });
const steerReceipt = z.object({ turnId: id });
const followUpInput = z.object({ clientId: z.uuid(), text: z.string().trim().min(1).max(24_000) });
const deliveredInput = z.object({ content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]) });
const desktopPatchCall = binding.extend({ callId: id, tool: z.literal("desktop_apply_patch"), namespace: z.null().nullish(),
  arguments: z.unknown() });
type NativePatchTool = import("./native-patches").NativePatchTool;

type Assignment = CodeNativeAssignment;
type ReadEvidence = { id: string; result: "running" | "succeeded" | "failed" | "unconfirmed"; model: Assignment; tool?: "apply_patch" | "read_file" | "list_files" };
export type CodexPlanRow = {
  id: string;
  title: string;
  state: "pending" | "running" | "unverified" | "completed" | "cancelled";
  assignment?: Assignment;
  evidenceStart?: number;
  evidence: ReadEvidence[];
};
export type CodexSteer = (clientId: string, text: string) => Promise<boolean>;
export type CodexPreviousTurn = { threadId: string; turnId: string; status: "completed" | "interrupted" | "failed" };
export type CodexTurnObservation = {
  status: "running" | "completed" | "interrupted" | "failed";
  session: Assignment;
  threadEffort?: string;
  requestedEffort?: "low" | "high";
  usage?: Extract<CodeNativeUsage, { source: "codex_thread" }>;
  hasUnconfirmedCommand?: true;
  usageLimitExceeded?: true;
  analysis?: TaskAnalysis;
  rows: CodexPlanRow[];
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  streamingAnswer?: string;
  pendingFollowUp?: string;
};
type Row = { title: string; phase: z.infer<typeof nativeStep>["status"] | "cancelled";
  assignment?: Assignment; evidence: ReadEvidence[]; evidenceStart?: number };
type StartedRead = { command: string; cwd: string; evidence: ReadEvidence };
type PendingSteer = { rpcId: number; clientId: string; text: string; accepted: boolean; delivered: boolean; resolve: (sent: boolean) => void };

const phaseOrder = { pending: 0, inProgress: 1, completed: 2, cancelled: 3 };
const maxAnswerLength = 24_000;
const answerText = (text: string) => safeText(text.slice(0, maxAnswerLength)).slice(0, maxAnswerLength);
const rowId = (text: string) => `codex-${createHash("sha256").update(text).digest("hex").slice(0, 24)}`;
const samePath = (a: string, b: string) => process.platform === "win32" ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b);
const codexAnalysisSummary = "Inspect relevant project files read-only first. Provide the public analysis as a JSON string in update_plan explanation with objective, verifiedFacts (array of strings), assumptions (array of strings), scope, verification, and completion.";
const codexAnalysisInstruction = `${codexAnalysisSummary} A simple answer does not require a plan. Mark the next work item in_progress. Publish fresh analysis after a new user instruction. Then use desktop_apply_patch to propose edits for Desktop approval.`;
const codexWorkspaceInstruction = "Inspect project files using the Desktop workspace MCP list and read tools. If inspection leaves the requested outcome or change scope unclear, ask a focused question and wait.";
const missingCodexAnalysis = "No Desktop file edit was applied. Publish the read-only analysis in update_plan and select an active item before proposing a patch.";

const verified = (row: Row) => {
  const current = row.evidence.slice(row.evidenceStart ?? 0);
  return row.phase === "completed" && current.length > 0 && current.every(({ result }) => result === "succeeded") &&
    !row.evidence.some(({ result }) => result === "running" || result === "unconfirmed");
};

type CodexStdio = { stdout: Readable; stdin: Writable };
type CodexConnection = { profile: string; root: string; version: string; signal: AbortSignal };

function codexMessages(child: CodexStdio) {
  const incoming = readCliFrames(child.stdout, 1024 * 1024);
  const send = (frame: Frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  const next = async () => {
    const result = await incoming.next();
    if (result.done) throw new Error("Codex ended before the native turn was confirmed.");
    return result.value;
  };
  const early: Frame[] = [];
  const reply = async (match: (frame: Frame) => boolean) => {
    for (;;) {
      const frame = await next();
      if (Object.hasOwn(frame, "id")) {
        if (!match(frame) || frame.method || Object.hasOwn(frame, "error")) throw new Error("Unexpected Codex response.");
        return frame;
      }
      if (early.length >= 32) throw new Error("Too many Codex notifications before the turn response.");
      early.push(frame);
    }
  };
  return { early, send, next, reply };
}

async function readLatestCodexTurn(io: ReturnType<typeof codexMessages>, root: string, session: Pick<Assignment, "threadId" | "turnId">) {
  const threadId = id.parse(session.threadId);
  io.send({ id: "saved-thread", method: "thread/read", params: { threadId, includeTurns: false } });
  const saved = storedThread.parse((await io.reply(({ id }) => id === "saved-thread")).result).thread;
  if (saved.id !== threadId || !samePath(root, saved.cwd)) throw new Error("Codex saved thread does not match the project.");
  io.send({ id: "saved-turn", method: "thread/turns/list", params: { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" } });
  const [last] = latestTurn.parse((await io.reply(({ id }) => id === "saved-turn")).result).data;
  if (last.id !== session.turnId) throw new Error("Codex saved turn did not match the requested turn.");
  return last.status;
}

export async function inspectCodexSavedTurn(child: CodexStdio, input: CodexConnection & { session: Assignment }) {
  const io = codexMessages(child);
  input.signal.throwIfAborted();
  await initializeCodex({ send: io.send, read: io.reply }, input.profile, input.version);
  const status = await readLatestCodexTurn(io, input.root, input.session);
  input.signal.throwIfAborted();
  io.send({ id: "saved-items", method: "thread/items/list", params: {
    threadId: input.session.threadId, turnId: input.session.turnId, limit: 64,
  } });
  const { data } = recordedItems.parse((await io.reply(({ id }) => id === "saved-items")).result);
  if (data.some(({ turnId }) => turnId !== input.session.turnId)) throw new Error("Codex saved items did not match the requested turn.");
  if (new Set(data.map(({ item }) => item.id)).size !== data.length) throw new Error("Codex saved items contain duplicate identifiers.");
  const commands = new Map<string, "succeeded" | "failed" | "unconfirmed">();
  for (const { item, completedAtMs } of data) {
    if (item.type !== "commandExecution") continue;
    const command = commandItem.safeParse(item);
    let result: "succeeded" | "failed" | "unconfirmed" = "unconfirmed";
    if (status !== "inProgress" && completedAtMs && command.success && samePath(input.root, command.data.cwd)) {
      const { status: commandStatus, exitCode, commandActions } = command.data;
      if (commandStatus === "completed" && exitCode === 0 && commandActions.length && commandActions.every(({ type }) => type !== "unknown")) {
        result = "succeeded";
      } else if (commandStatus === "declined" || ((commandStatus === "completed" || commandStatus === "failed") && typeof exitCode === "number" && exitCode !== 0)) {
        result = "failed";
      }
    }
    commands.set(item.id, result);
  }
  return { status, commands };
}

export async function observeCodexFixtureTurn(
  child: CodexStdio,
  input: CodexConnection & { model: string; prompt: string; planOnly?: boolean; effort?: "low" | "high";
    history?: { previous?: CodexPreviousTurn }; patchTool?: NativePatchTool; verifyDestination?: true; verifySource?: (signal: AbortSignal) => Promise<void>;
    workspace?: CodexWorkspace },
  publish: (observation: CodexTurnObservation) => void,
  steeringReady?: (steer: CodexSteer) => void,
): Promise<CodexTurnObservation> {
  const io = codexMessages(child);
  const { early, send, next, reply } = io;
  input.signal.throwIfAborted();
  await initializeCodex({ send, read: reply }, input.profile, input.version, !!input.patchTool);
  const supportedEfforts = input.verifyDestination ? await verifyCodexLoopbackDestination({ send, read: reply }, input.model) : undefined;
  const effort = input.effort && (!supportedEfforts || supportedEfforts.includes(input.effort)) ? input.effort : undefined;
  const previous = input.history?.previous;
  if (previous) {
    const savedStatus = await readLatestCodexTurn(io, input.root, previous);
    if (savedStatus !== previous.status) throw new Error("Codex saved turn did not match the last confirmed status.");
  }
  input.signal.throwIfAborted();
  const instructions = input.planOnly ? `${codexAnalysisSummary} Publish pending work items and stop before implementation.`
    : input.patchTool ? codexAnalysisInstruction : undefined;
  send({ id: 2, method: previous ? "thread/resume" : "thread/start", params: {
    cwd: input.root, model: modelId.parse(input.model), modelProvider: codexFixtureProvider,
    sandbox: "read-only", approvalPolicy: "never",
    ...(previous ? { threadId: previous.threadId, excludeTurns: true } : { ephemeral: !input.history }),
    ...(instructions && { developerInstructions: input.workspace ? `${codexWorkspaceInstruction} ${instructions}` : instructions }),
    ...(!previous && !input.planOnly && input.patchTool && { dynamicTools: [input.patchTool.spec] }),
  } });
  const thread = threadResponse.parse((await reply((frame) => frame.id === 2)).result);
  if (!samePath(input.root, thread.cwd) || !samePath(input.root, thread.thread.cwd) || thread.model !== input.model ||
      thread.thread.ephemeral !== !input.history || (previous && thread.thread.id !== previous.threadId)) {
    throw new Error("Codex did not confirm the requested workspace and model.");
  }
  input.signal.throwIfAborted();
  if (input.verifySource) await input.verifySource(input.signal);
  input.signal.throwIfAborted();
  send({ id: 3, method: "turn/start", params: {
    threadId: thread.thread.id, cwd: input.root, sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalPolicy: "never",
    input: [{ type: "text", text: z.string().trim().min(1).max(24_000).parse(input.prompt), textElements: [] }],
    ...(effort ? { effort } : {}),
  } });
  const started = turnResponse.parse((await reply((frame) => frame.id === 3)).result);
  if (previous?.turnId === started.turn.id) throw new Error("Codex did not open a new turn in the saved thread.");
  const session = { model: thread.model, threadId: thread.thread.id, turnId: started.turn.id };
  let reportedModel: Assignment["reportedModel"];
  let usage: CodexTurnObservation["usage"];
  let status: CodexTurnObservation["status"] = "running";
  let hasUnconfirmedCommand: true | undefined;
  let usageLimitExceeded = false;
  let analysis: TaskAnalysis | undefined;
  let rows: Row[] = [];
  const reads = new Map<string, StartedRead>();
  const workspaceReads = new Map<string, ReadEvidence>();
  const patches = new Map<string, ReadEvidence>();
  const messages: CodexTurnObservation["messages"] = [];
  const assistantIds = new Set<string>();
  let preview: { id: string; text: string } | undefined;
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSteer: PendingSteer | undefined;
  let stopBeforeDelivery = false;
  let nextSteerId = 5;
  const declined = new Set<string | number>();
  const matchesTurn = (value: z.infer<typeof binding>) => value.threadId === session.threadId && value.turnId === session.turnId;
  const assignment = (): Assignment => reportedModel ? { ...session, reportedModel } : session;
  const observation = (): CodexTurnObservation => ({
    status, session: assignment(), threadEffort: thread.reasoningEffort ?? undefined, requestedEffort: input.effort, hasUnconfirmedCommand, usage,
    usageLimitExceeded: usageLimitExceeded && !hasUnconfirmedCommand ? true : undefined,
    analysis, messages: [...messages],
    streamingAnswer: status === "running" && !input.signal.aborted && preview?.text ? answerText(preview.text) : undefined,
    pendingFollowUp: pendingSteer?.accepted ? safeText(pendingSteer.text) : undefined,
    rows: rows.map((row) => ({
      id: rowId(row.title), title: row.title, assignment: row.assignment, evidenceStart: row.evidenceStart,
      evidence: row.evidence.map((item) => ({ ...item })),
      state: row.phase === "cancelled" ? "cancelled" : row.phase === "pending" ? "pending"
        : row.phase === "inProgress" && status === "running" ? "running"
        : verified(row) ? "completed" : "unverified",
    })),
  });
  const publishState = () => {
    clearTimeout(streamTimer);
    streamTimer = undefined;
    publish(observation());
  };
  const steer: CodexSteer = (clientId, text) => {
    const parsed = followUpInput.safeParse({ clientId, text });
    if (!parsed.success || status !== "running" || input.signal.aborted || pendingSteer) return Promise.resolve(false);
    const rpcId = nextSteerId++;
    return new Promise((resolve) => {
      pendingSteer = { ...parsed.data, rpcId, accepted: false, delivered: false, resolve };
      try {
        send({ id: rpcId, method: "turn/steer", params: {
          threadId: session.threadId, expectedTurnId: session.turnId, clientUserMessageId: clientId,
          input: [{ type: "text", text: parsed.data.text, textElements: [] }],
        } });
      } catch {
        pendingSteer = undefined;
        resolve(false);
      }
    });
  };
  const confirmDelivery = () => {
    const followUp = pendingSteer;
    if (followUp?.accepted && followUp.delivered) {
      pendingSteer = undefined;
      analysis = undefined;
      input.workspace?.clear();
      messages.push({ role: "user", text: safeText(followUp.text) });
      for (const row of rows) {
        if (row.phase === "cancelled" || verified(row)) continue;
        row.phase = "pending";
        row.assignment = undefined;
        row.evidenceStart = row.evidence.length;
      }
      followUp.resolve(true);
    }
    publishState();
  };
  const interrupt = () => {
    if (pendingSteer) {
      // Codex can deliver queued input while handling interrupt. Return control to the process owner for termination.
      stopBeforeDelivery = true;
      child.stdout.destroy();
      return;
    }
    send({ id: 4, method: "turn/interrupt", params: { threadId: session.threadId, turnId: session.turnId } });
  };
  input.signal.addEventListener("abort", interrupt, { once: true });
  if (input.signal.aborted) interrupt();
  try {
    steeringReady?.(steer);
    publishState();
    while (status === "running") {
      const frame = early.shift() ?? await next();
      if (stopBeforeDelivery) throw new Error("Codex was stopped before confirming the instruction.");
      if (Object.hasOwn(frame, "id")) {
        if (frame.id === 4 && input.signal.aborted && !frame.method && !Object.hasOwn(frame, "error")) continue;
        if (!frame.method && typeof frame.id === "number" && frame.id >= 5 && frame.id < nextSteerId) {
          if (!pendingSteer || pendingSteer.rpcId !== frame.id || pendingSteer.accepted) continue;
          if (Object.hasOwn(frame, "error")) {
            if (pendingSteer.delivered) throw new Error("Codex returned conflicting instruction receipts.");
            pendingSteer.resolve(false);
            pendingSteer = undefined;
            continue;
          }
          const receipt = steerReceipt.safeParse(frame.result);
          if (!receipt.success || receipt.data.turnId !== session.turnId) throw new Error("Codex did not acknowledge the expected turn.");
          pendingSteer.accepted = true;
          confirmDelivery();
          continue;
        }
        const target = binding.safeParse(frame.params);
        if (frame.method === "item/tool/call" && input.patchTool && (typeof frame.id === "string" || typeof frame.id === "number")) {
          const request = desktopPatchCall.parse(frame.params);
          if (!matchesTurn(request) || patches.has(request.callId) || patches.size >= 24) {
            throw new Error("Codex sent an unexpected Desktop patch request.");
          }
          const evidence: ReadEvidence = { id: request.callId, model: assignment(), tool: "apply_patch", result: "running" };
          patches.set(request.callId, evidence);
          const active = rows.find(({ phase }) => phase === "inProgress");
          if (input.planOnly || pendingSteer || !analysis || !active) {
            evidence.result = "failed";
            send({ id: frame.id, result: { success: false, contentItems: [{ type: "inputText", text: missingCodexAnalysis }] } });
            continue;
          }
          active.evidence.push(evidence);
          publishState();
          const result = await input.patchTool.invoke(request.callId, request.arguments, input.signal);
          evidence.result = result.success ? "succeeded" : "failed";
          send({ id: frame.id, result: { success: result.success, contentItems: [{ type: "inputText", text: result.text }] } });
          publishState();
          continue;
        }
        if ((frame.method === "item/commandExecution/requestApproval" || frame.method === "item/fileChange/requestApproval") &&
            target.success && matchesTurn(target.data) && (typeof frame.id === "number" || typeof frame.id === "string") && !declined.has(frame.id)) {
          declined.add(frame.id);
          send({ id: frame.id, result: { decision: "decline" } });
          continue;
        }
        throw new Error("Unexpected Codex request during a read-only turn.");
      }
      if (frame.method === "turn/plan/updated") {
        const parsed = planUpdate.safeParse(frame.params);
        if (!parsed.success || !matchesTurn(parsed.data)) continue;
        const previous = new Map(rows.map((row) => [row.title, row]));
        const received = parsed.data.plan.map(({ step, status }) => ({ title: safeLine(step).trim(), phase: input.planOnly ? "pending" as const : status }));
        const titles = new Set(received.map(({ title }) => title));
        if (titles.has("") || titles.size !== received.length || received.some(({ title, phase }) => {
          const existing = previous.get(title);
          return existing && phaseOrder[phase] < phaseOrder[existing.phase];
        })) continue;
        const removed = rows.filter(({ title }) => !titles.has(title));
        if (received.length + removed.length > 24) continue;
        rows = received.map(({ title, phase }) => {
          const row: Row = previous.get(title) ?? { title, phase, evidence: [] };
          row.phase = phase;
          if (phase === "inProgress") row.assignment ??= assignment();
          return row;
        });
        for (const row of removed) {
          if (row.phase !== "completed") row.phase = "cancelled";
          rows.push(row);
        }
        if (!pendingSteer && received.length) analysis = parseTaskAnalysis(parsed.data.explanation) ?? analysis;
      } else if (frame.method === "thread/tokenUsage/updated") {
        const parsed = tokenUsage.safeParse(frame.params);
        if (!parsed.success || !matchesTurn(parsed.data)) continue;
        const { totalTokens } = parsed.data.tokenUsage.total;
        if (usage && totalTokens <= usage.totalTokens) continue;
        usage = { source: "codex_thread", totalTokens };
      } else if (frame.method === "model/rerouted") {
        const parsed = rerouted.safeParse(frame.params);
        if (!parsed.success || !matchesTurn(parsed.data) || parsed.data.fromModel !== (reportedModel?.model ?? session.model) ||
            parsed.data.fromModel === parsed.data.toModel) continue;
        reportedModel = { source: "codex_reroute", model: parsed.data.toModel, previousModel: parsed.data.fromModel };
        const row = rows.find(({ phase }) => phase === "inProgress");
        if (row) row.assignment = assignment();
      } else if (frame.method === "item/agentMessage/delta") {
        const parsed = publicDelta.safeParse(frame.params);
        if (!parsed.success || !matchesTurn(parsed.data) || input.signal.aborted || preview?.id !== parsed.data.itemId ||
            preview.text.length === maxAnswerLength) continue;
        preview.text += parsed.data.delta.slice(0, maxAnswerLength - preview.text.length);
        streamTimer ??= setTimeout(publishState, 48);
        continue;
      } else if (frame.method === "item/started" || frame.method === "item/completed") {
        const parsed = itemUpdate.safeParse(frame.params);
        if (!parsed.success || !matchesTurn(parsed.data)) continue;
        const item = parsed.data.item;
        if (item.type === "fileChange") throw new Error("Codex reported a file edit during a read-only turn.");
        if (item.type === "mcpToolCall" && input.workspace && !pendingSteer && !input.signal.aborted) {
          if (frame.method === "item/started" && workspaceReads.has(item.id)) continue;
          const read = input.workspace.observe(item, frame.method === "item/started");
          if (read?.state === "running") {
            if (workspaceReads.size >= 64) throw new Error("Too many Codex workspace reads to verify the turn.");
            const evidence: ReadEvidence = { id: read.id, model: assignment(), tool: read.tool, result: "running" };
            workspaceReads.set(read.id, evidence);
            rows.find(({ phase }) => phase === "inProgress")?.evidence.push(evidence);
          } else if (read) {
            const evidence = workspaceReads.get(read.id);
            if (evidence?.result === "running") evidence.result = read.state;
          }
        }
        if (item.type === "agentMessage" && frame.method === "item/started" && !preview && !assistantIds.has(item.id) && assistantIds.size < 16) {
          preview = { id: item.id, text: "" };
        } else if (item.type === "agentMessage" && frame.method === "item/completed") {
          if (preview?.id === item.id) preview = undefined;
          const message = publicMessage.safeParse(item);
          if (message.success && assistantIds.size < 16 && !assistantIds.has(item.id)) {
            assistantIds.add(item.id);
            messages.push({ role: "assistant", text: answerText(message.data.text) });
          }
        }
        if (item.type === "userMessage" && frame.method === "item/completed" && pendingSteer && item.clientId === pendingSteer.clientId) {
          const message = deliveredInput.safeParse(item);
          if (!message.success || message.data.content[0].text !== pendingSteer.text) throw new Error("Codex delivered a different instruction.");
          pendingSteer.delivered = true;
          confirmDelivery();
          continue;
        }
        if (item.type === "commandExecution") {
          if (input.workspace) throw new Error("Codex reported a command during a workspace inspection.");
          const command = commandItem.safeParse(item);
          if (!command.success) {
            hasUnconfirmedCommand = true;
            continue;
          }
          if (frame.method === "item/started" && command.data.status === "inProgress") {
            if (reads.has(item.id)) continue;
            if (reads.size >= 64) throw new Error("Too many Codex read results to verify the turn.");
            const evidence: ReadEvidence = { id: item.id, result: "running", model: assignment() };
            reads.set(item.id, { command: command.data.command, cwd: command.data.cwd, evidence });
            if (samePath(input.root, command.data.cwd)) rows.find(({ phase }) => phase === "inProgress")?.evidence.push(evidence);
          } else if (frame.method === "item/completed") {
            const read = reads.get(item.id);
            if (!read || read.evidence.result !== "running" || read.command !== command.data.command ||
                !samePath(read.cwd, command.data.cwd) || command.data.status === "inProgress") continue;
            read.evidence.result = command.data.status !== "completed" || command.data.exitCode !== 0 ? "failed"
              : command.data.commandActions.length && command.data.commandActions.every(({ type }) => type !== "unknown") ? "succeeded" : "unconfirmed";
          }
        }
      } else if (frame.method === "turn/completed") {
        const result = turnEnd.safeParse(frame.params);
        if (!result.success || result.data.threadId !== session.threadId || result.data.turn.id !== session.turnId) continue;
        status = result.data.turn.status;
        usageLimitExceeded = status === "failed" && !input.signal.aborted && !pendingSteer &&
          result.data.turn.error?.codexErrorInfo === "usageLimitExceeded";
        pendingSteer?.resolve(false);
        pendingSteer = undefined;
        for (const { evidence } of reads.values()) {
          if (evidence.result === "running") {
            hasUnconfirmedCommand = true;
            evidence.result = "unconfirmed";
          }
        }
        for (const evidence of workspaceReads.values()) {
          if (evidence.result === "running") evidence.result = "unconfirmed";
        }
        if (status === "interrupted") for (const row of rows) if (row.phase !== "completed") row.phase = "cancelled";
      } else {
        continue;
      }
      publishState();
    }
    return observation();
  } finally {
    input.workspace?.clear();
    clearTimeout(streamTimer);
    input.signal.removeEventListener("abort", interrupt);
    if (status === "running") status = "failed";
    pendingSteer?.resolve(false);
    pendingSteer = undefined;
  }
}
