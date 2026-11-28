import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { safeText } from "../../../tomverse-cli/src/display.js";
import { canonicalDigest } from "../../../tomverse-cli/src/session.js";
import type { TaskAnalysis } from "../../../tomverse-cli/src/task-plan.js";
import { patchSchema, readFileTool } from "../../../tomverse-cli/src/tools.js";
import { Workspace } from "../../../tomverse-cli/src/workspace.js";
import { MAX_CODE_PROMPT_CHARACTERS, zCodeNativeSessionId, zCodePlanQuotaCode, type CodeNativeAssignment, type CodeNativeUsage,
  type CodeQuotaEvidence } from "../contract";
import type { AcpTurn } from "./acp-turn";
import { readCliFrames, type Frame } from "./cli-protocol";
import { hasCredential } from "./journal-view";
import { nativeReadInput, nativeReadName, startNativeMcpServer } from "./native-mcp-server";
import type { NativePatchTool } from "./native-patches";
import { completedNativeRow, maxNativePlanItems, nativeAnalysisInstruction, nativePlanPhase, reconcileNativeRows, snapshotNativePlan,
  type NativeAnalysis, type NativeRow } from "./native-task-rows";
import { assertProjectRoot, type ProjectRoot } from "./project-root";
import { startZCodeFixtureProxy, zCodeFixtureProvider, zCodeFixtureSelection, zCodePlanProvider } from "./zcode-fixture";

const readName = "mcp__desktop__desktop_read_file";
const patchName = "mcp__desktop__desktop_apply_patch";
const todoName = "TodoWrite";
const id = z.string().regex(/^[\w.:-]{1,160}$/);
const rpcId = z.union([id, z.int()]);
const sequence = z.int().nonnegative();
const workspaceScope = z.object({ workspacePath: z.string(), workspaceKey: z.string() });
const snapshotSchema = z.object({ protocol: z.object({ name: z.literal("ZCode Protocol"), version: z.literal(1) }),
  session: z.object({ sessionId: zCodeNativeSessionId, workspace: workspaceScope, mode: z.literal("build"),
    model: z.object({ providerId: z.enum([zCodeFixtureProvider, zCodePlanProvider]), modelId: id }) }),
  runtime: z.object({ eventSeq: sequence, pendingRequestIds: z.tuple([]) }) });
const eventSchema = z.object({ deliveryKind: z.literal("desktop-continuous"), seq: sequence,
  sessionId: zCodeNativeSessionId, turnId: id.optional(), eventId: z.unknown().optional(), type: z.string(), payload: z.record(z.string(), z.unknown()) });
const providerUsage = z.object({ source: z.literal("provider"), modelRequestCount: z.int().positive(),
  inputTokens: sequence, outputTokens: sequence });
const codingPlanFailure = z.object({ error: z.object({ attribution: z.object({
  source: z.literal("provider"), reason: z.literal("rate_limited"), exceptionKind: z.literal("provider_business"),
  providerId: z.literal(zCodePlanProvider), providerKind: z.literal("anthropic"), modelId: id,
  statusCode: z.literal(429), providerErrorCode: zCodePlanQuotaCode, retryable: z.literal(false),
}) }) });
const proposalSchema = z.object({ kind: z.literal("tool_call"), toolCallId: id, assistantMessageId: id,
  toolName: z.enum([readName, patchName, todoName]), input: z.unknown() });
const toolUpdateSchema = z.object({ toolCallId: id, kind: z.enum(["scheduled", "started", "result", "error"]),
  toolName: z.string().optional(), assistantMessageId: id.optional(), result: z.object({
    success: z.boolean(), truncated: z.boolean().optional(), content: z.string().max(128_000).optional(),
  }).optional() });
const todoInput = z.object({ todos: z.array(z.object({
  content: z.string().trim().min(1).max(1600), status: nativePlanPhase, priority: z.enum(["low", "medium", "high"]),
})).max(maxNativePlanItems) });
const commandAck = z.object({ commandId: z.uuid(), status: z.string(), reasonCode: z.string().optional(), revisionAtDecision: sequence });
const guideAck = commandAck.extend({ status: z.literal("accepted"), result: z.object({
  type: z.literal("inputAccepted"), delivery: z.enum(["queue", "startNow"]), inputId: z.uuid(),
}) });
const drainedGuide = z.object({ targetTurnId: id, pendingInputIds: z.tuple([id]), drainedInputs: z.tuple([z.object({
  pendingInputId: id, messageId: id, text: z.string(), delivery: z.literal("guide"), intent: z.object({ sourceCommandId: z.uuid() }),
})]) });

type Evidence = NativeRow["evidence"][number];
type ZCodeStatus = "stopped" | "completed" | "failed";
type ZCodeQuota = Extract<CodeQuotaEvidence, { source: "zcode" }>;
type Proposal = z.infer<typeof proposalSchema> & {
  digest: string; state: "proposed" | "scheduled" | "started" | "settled"; outcome?: boolean;
  evidence?: Evidence; analysis?: NativeAnalysis;
};
type TurnInput = { project: ProjectRoot; protectedRoots: string[]; connectionKey: string; model: string; origin: string;
  prompt: string; mode: "ask" | "plan" | "agent"; signal: AbortSignal;
  previous?: { session: CodeNativeAssignment; plan?: AcpTurn["plan"] }; patchTool?: NativePatchTool; codingPlanRevision?: string;
  beforeFollowUp?: () => void };
type FollowUp = { text: string; scopedText: string; commandId: string; queueItemId: string;
  delivery?: "queue" | "startNow"; applied?: "queue" | "startNow"; resolve: (sent: boolean) => void };

export async function observeZCodeTurn(
  launch: (proxyOrigin: string) => { stdout: Readable; stdin: Writable },
  input: TurnInput,
  publish: (turn: AcpTurn) => void,
  registerFollowUp?: (queue: (text: string) => Promise<boolean>) => void,
) {
  const shutdown = new AbortController();
  const signal = AbortSignal.any([shutdown.signal, input.signal]);
  const files = new Workspace(input.project.path, input.protectedRoots);
  const effects = new Map<string, Proposal>();
  const ready = new EventEmitter();
  const prior = input.previous?.plan?.items ?? [];
  const planOnly = input.mode === "plan";
  const priorCalls = new Set(prior.flatMap(({ evidence }) => evidence.map(({ nativeItemId }) => nativeItemId)));
  let rows = new Map(prior.map((row) => [row.id, row]));
  let activeAnalysis: NativeAnalysis | undefined;
  const workspace = { workspacePath: input.project.path, workspaceKey: input.project.path };
  const selection = zCodeFixtureSelection(input.model, !!input.codingPlanRevision);
  let analysis: TaskAnalysis | undefined;
  let acceptedPlan = false;
  let session: CodeNativeAssignment | undefined;
  let nativeTurn: string | undefined;
  let streaming = false;
  let stopSent = false;
  let answer = "";
  let inputId: string = randomUUID();
  let assignmentId: string = randomUUID();
  let followUp: FollowUp | undefined;
  let guided = false;
  let usage: Extract<CodeNativeUsage, { source: "zcode_turn" }> | undefined;
  const messages: AcpTurn["messages"] = [];
  const activeRow = () => acceptedPlan ? [...rows.values()].find((row) =>
    !row.cancelled && row.nativeStatus === "in_progress" && row.nativeAssignment?.turnId === assignmentId) : undefined;
  const snapshot = (status?: ZCodeStatus): Exclude<AcpTurn, { status: "blocked" }> => ({
    session: session!, status, usage, answer: !status && answer ? safeText(answer) : undefined,
    messages: status && answer ? [...messages, { role: "assistant", text: safeText(answer) }] : [...messages],
    pendingFollowUp: followUp && !followUp.applied ? followUp.text : undefined,
    plan: snapshotNativePlan(rows, { activeId: streaming ? activeRow()?.id ?? null : null,
      analysis, streaming, stopped: status === "stopped", planOnly }),
  });
  const hasRead = () => [...effects.values()].some((effect) => effect.toolName === readName &&
    effect.evidence?.state === "succeeded");
  const canInvoke = (effect: Proposal) => streaming && !signal.aborted && effect.state === "started" &&
    (effect.toolName === readName || !followUp && !!activeAnalysis && activeAnalysis === effect.analysis && hasRead());
  const mcp = await startNativeMcpServer({
    patch: input.patchTool,
    read: (callId, args, requestSignal) => {
      const effect = effects.get(callId)!;
      effect.outcome = false;
      requestSignal.throwIfAborted();
      assertProjectRoot(input.project);
      const result = readFileTool({ workspace: files, readByteLimit: 256 * 1024 }, args);
      if (result.status !== "ok" || typeof result.text !== "string" || hasCredential(result.text, input.connectionKey)) {
        throw new Error("The file is unavailable in the Desktop workspace.");
      }
      effect.outcome = true;
      return result.text;
    },
    onPatchResult: (callId, success) => { effects.get(callId)!.outcome = success; },
  }, signal, async (args, requestSignal, name) => {
    const tool = name === nativeReadName ? readName : patchName;
    const digest = canonicalDigest(args);
    const wait = AbortSignal.any([requestSignal, AbortSignal.timeout(5_000)]);
    while (streaming && !wait.aborted) {
      const matches = [...effects.values()].filter((effect) => effect.toolName === tool && effect.digest === digest && effect.state === "started");
      if (matches.length > 1) return;
      const [effect] = matches;
      if (effect) return { id: effect.toolCallId, input: effect.input, canApply: () => canInvoke(effect) };
      await once(ready, "started", { signal: wait });
    }
  });

  let proxy: Awaited<ReturnType<typeof startZCodeFixtureProxy>> | undefined;
  let onCancel: (() => void) | undefined;
  try {
    proxy = await startZCodeFixtureProxy(input.origin, mcp.descriptor.url, shutdown.signal);
    signal.throwIfAborted();
    const child = launch(proxy.origin);
    const frames = readCliFrames(child.stdout, 2 * 1024 * 1024);
    const send = (data: Frame) => child.stdin.write(JSON.stringify(data) + "\n");
    const request = (requestId: number, method: string, params: Frame) => send({ id: requestId, method, params });
    const next = async () => {
      const result = await frames.next();
      if (result.done || Object.hasOwn(result.value, "jsonrpc")) throw new Error("The ZCode protocol connection closed or changed.");
      return result.value;
    };
    const replyToRequest = (frame: Frame) => {
      const requestId = rpcId.parse(frame.id);
      if (frame.method === "session/requestRuntimePreferences" &&
          z.object({ sessionId: session ? z.literal(session.threadId) : zCodeNativeSessionId,
            scope: z.literal("user-execution") }).safeParse(frame.params).success) {
        send({ id: requestId, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false } });
      } else if (frame.method === "interaction/requestProviderRuntimeHeaders" && input.codingPlanRevision &&
          streaming && !signal.aborted && session && nativeTurn && z.object({
            sessionId: z.literal(session.threadId), turnId: z.literal(nativeTurn), providerId: z.literal(zCodePlanProvider),
            workspace: z.object({ workspacePath: z.literal(workspace.workspacePath), workspaceKey: z.literal(workspace.workspaceKey) }),
            modelSelection: z.object({ providerId: z.literal(zCodePlanProvider), modelId: z.literal(input.model) }),
          }).safeParse(frame.params).success) {
        send({ id: requestId, result: { headersApplied: true, requestAuth: { apiKey: "tomverse-loopback-only" } } });
      } else if (frame.method === "interaction/requestPermission") send({ id: requestId, result: { decision: "deny" } });
      else send({ id: requestId, error: { code: -32601, message: "Desktop did not authorize the requested action." } });
    };
    const receive = async (requestId: number) => {
      for (;;) {
        const frame = await next();
        if (frame.method && Object.hasOwn(frame, "id")) replyToRequest(frame);
        else if (Object.hasOwn(frame, "id")) {
          if (frame.id !== requestId || Object.hasOwn(frame, "error")) throw new Error("ZCode refused a scoped request.");
          return frame.result;
        }
      }
    };
    const tools = [todoName, readName, ...(input.patchTool ? [patchName] : [])];
    if (input.codingPlanRevision) {
      request(5, "provider/updateAccountConfig", { revision: "tomverse-loopback", basedOnZCodeBuiltinRevision: input.codingPlanRevision,
        providers: { [zCodePlanProvider]: { access: { type: "zhipu-account", entitled: true } } },
        states: { [zCodePlanProvider]: { availability: "available", entitled: true, current: true } },
      });
      z.object({ receivedRevision: z.literal("tomverse-loopback"), providerCount: z.literal(1),
        status: z.literal("received") }).parse(await receive(5));
    }
    request(1, input.previous ? "session/resume" : "session/create", { workspace, toolAllowlist: tools,
      mcpServers: [{ ...mcp.descriptor, protocolVersion: "legacy", isolation: "session", alwaysLoad: true }],
      ...(input.previous ? { sessionId: input.previous.session.threadId } :
        { mode: "build", model: selection, persistence: "immediate", titleGenerationEnabled: false }),
    });
    const created = snapshotSchema.parse(await receive(1));
    const threadId = created.session.sessionId;
    if (created.session.workspace.workspacePath !== workspace.workspacePath || created.session.workspace.workspaceKey !== workspace.workspaceKey ||
        created.session.model.providerId !== selection.providerId || created.session.model.modelId !== input.model ||
        input.previous && input.previous.session.threadId !== threadId) {
      throw new Error("ZCode did not confirm the scoped model and workspace.");
    }
    session = { provider: "zhipu", model: input.model, threadId, turnId: assignmentId };
    request(2, "session/subscribe", { sessionId: threadId, deliveryKind: "desktop-continuous", includeSnapshot: false });
    const subscribed = z.object({ sessionId: z.literal(threadId), eventSeq: sequence, events: z.tuple([]) }).parse(await receive(2));
    if (subscribed.eventSeq < created.runtime.eventSeq) throw new Error("The ZCode event cursor moved backwards.");
    let cursor = subscribed.eventSeq;
    signal.throwIfAborted();
    assertProjectRoot(input.project);
    const modeInstruction = input.mode === "agent"
      ? `Submit edits only through ${patchName} after a successful workspace read and a current active row with analysis. Every edit needs Desktop approval.`
      : planOnly ? "Publish the ordered task list with pending items and stop before implementation." : "";
    const scopedPrompt = (text: string, turnId: string) => [text, "Desktop instructions:",
      `Use ${readName} to read project files and ${todoName} to update tasks.`,
      ...(input.mode === "ask" ? [] : [nativeAnalysisInstruction(turnId), modeInstruction])].join("\n\n");
    const v4Command = (requestId: number, commandId: string, type: string, payload: Frame, baseRevision?: number) =>
      request(requestId, "v4/command", { commandId, clientId: "tomverse-desktop", sessionId: threadId,
        workspace, type, payload, issuedAt: Date.now(), baseRevision });
    request(3, "session/send", { sessionId: threadId, content: scopedPrompt(input.prompt, assignmentId), modelSelection: selection, inputId });
    streaming = true;
    publish(snapshot());
    let stopCommandId: string | undefined;
    onCancel = () => {
      if ((!streaming && !followUp) || stopSent) return;
      stopSent = true;
      if (guided || followUp) {
        stopCommandId = randomUUID();
        v4Command(4, stopCommandId, "stop", {});
      } else request(4, "session/stop", { sessionId: threadId });
    };
    input.signal.addEventListener("abort", onCancel, { once: true });
    if (input.signal.aborted) onCancel();
    let sendAccepted = false;
    let stopAccepted = false;
    let terminal: ZCodeStatus | undefined;
    let quota: ZCodeQuota | undefined;
    let nextGuideRequest = 10;
    let guideRequest: number | undefined;
    const finishGuide = () => {
      if (!followUp?.applied || !followUp.delivery) return;
      if (followUp.applied !== followUp.delivery) throw new Error("ZCode reported conflicting follow-up delivery.");
      const confirmed = followUp;
      followUp = undefined;
      confirmed.resolve(true);
      publish(snapshot());
    };
    const applyGuide = (delivery: NonNullable<FollowUp["applied"]>) => {
      if (!followUp || followUp.applied || [...effects.values()].some(({ state }) => state === "started")) {
        throw new Error("ZCode changed the task while a tool outcome was still pending.");
      }
      if (answer.trim()) messages.push({ role: "assistant", text: safeText(answer) });
      answer = "";
      assignmentId = followUp.commandId;
      session = { ...session!, turnId: assignmentId };
      for (const callId of effects.keys()) priorCalls.add(callId);
      effects.clear();
      for (const [key, row] of rows) {
        if (row.cancelled || (!planOnly && completedNativeRow(row))) continue;
        rows.set(key, { ...row, nativeStatus: "pending", evidenceStart: row.evidence.length, nativeAssignment: undefined });
      }
      acceptedPlan = false;
      activeAnalysis = undefined;
      analysis = undefined;
      messages.push({ role: "user", text: followUp.text });
      followUp.applied = delivery;
      guided = true;
      finishGuide();
    };
    registerFollowUp?.(async (text) => {
      const trimmed = text.trim();
      if (!streaming || !sendAccepted || !nativeTurn || signal.aborted || followUp ||
          [...effects.values()].some(({ state, toolName }) => state === "started" && toolName === patchName) ||
          !trimmed || trimmed.length > MAX_CODE_PROMPT_CHARACTERS || /^[\/!]/.test(trimmed) || hasCredential(trimmed, input.connectionKey)) {
        return false;
      }
      input.beforeFollowUp?.();
      return new Promise<boolean>((resolve) => {
        const commandId = randomUUID();
        followUp = { text: trimmed, commandId, queueItemId: `queue_${commandId}`, scopedText: scopedPrompt(trimmed, commandId), resolve };
        guideRequest = nextGuideRequest++;
        v4Command(guideRequest, commandId, "sendText", { text: followUp.scopedText, modelSelection: selection, requestedDelivery: "guide" });
        publish(snapshot());
      });
    });
    while (!terminal || stopSent && !stopAccepted || !sendAccepted || followUp && (!followUp.delivery || followUp.delivery === "startNow")) {
      const frame = await next();
      if (frame.method && Object.hasOwn(frame, "id")) {
        replyToRequest(frame);
        continue;
      }
      if (frame.id === 3 && !frame.error && !sendAccepted) {
        z.object({ sessionId: z.literal(threadId), accepted: z.literal(true) }).parse(frame.result);
        sendAccepted = true;
        continue;
      }
      if (frame.id === 4 && !frame.error && stopSent && !stopAccepted) {
        if (stopCommandId) commandAck.extend({ commandId: z.literal(stopCommandId), status: z.literal("accepted") }).parse(frame.result);
        else z.object({}).strict().parse(frame.result);
        stopAccepted = true;
        continue;
      }
      if (followUp && frame.id === guideRequest && !frame.error && !followUp.delivery) {
        const ack = commandAck.extend({ commandId: z.literal(followUp.commandId) }).parse(frame.result);
        if (ack.status === "rejected" && !followUp.applied) {
          followUp.resolve(false);
          followUp = undefined;
          publish(snapshot());
          continue;
        }
        const result = guideAck.parse(frame.result).result;
        if (result.inputId !== followUp.commandId) throw new Error("ZCode acknowledged a different follow-up.");
        followUp.delivery = result.delivery;
        finishGuide();
        continue;
      }
      if (Object.hasOwn(frame, "id")) throw new Error("ZCode refused or repeated a turn request.");
      if (frame.method !== "session/event") continue;
      const event = eventSchema.parse(frame.params);
      if (event.sessionId !== threadId || event.seq !== ++cursor) throw new Error("ZCode changed the active event stream.");
      if (event.type === "turn.started") {
        if (terminal && followUp && event.payload.inputId === followUp.commandId && event.turnId && event.turnId !== nativeTurn) {
          // The previous turn can finish before the CLI admits a guide.
          if (usage) publish(snapshot(terminal));
          usage = undefined;
          inputId = followUp.commandId;
          terminal = undefined;
          quota = undefined;
          streaming = true;
          nativeTurn = event.turnId;
          applyGuide("startNow");
          continue;
        }
        if (nativeTurn || !event.turnId || event.payload.inputId !== inputId) throw new Error("ZCode started an unexpected turn.");
        nativeTurn = event.turnId;
      }
      if (!nativeTurn || event.turnId !== nativeTurn || terminal) continue;
      if (event.type === "turn.steerDrained" && followUp) {
        const receipt = drainedGuide.parse(event.payload);
        const [entry] = receipt.drainedInputs;
        if (receipt.targetTurnId !== nativeTurn || receipt.pendingInputIds[0] !== followUp.queueItemId ||
            entry.pendingInputId !== followUp.queueItemId || entry.intent.sourceCommandId !== followUp.commandId || entry.text !== followUp.scopedText) {
          throw new Error("ZCode reported a different follow-up receipt.");
        }
        applyGuide("queue");
        continue;
      }
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        if (event.payload.inputId !== inputId || [...effects.values()].some(({ state }) => state === "started")) {
          throw new Error("ZCode finished before its turn and tool outcomes could be confirmed.");
        }
        const result = event.payload.resultType;
        terminal = result === "cancelled" && stopSent && signal.aborted ? "stopped" :
          event.type === "turn.completed" && !Object.hasOwn(event.payload, "error") &&
          result === "success" && !signal.aborted && !stopSent ? "completed" : "failed";
        if (event.type === "turn.failed" && input.codingPlanRevision && !signal.aborted && !stopSent &&
            ![...effects.values()].some(({ state }) => state === "scheduled")) {
          const failure = codingPlanFailure.safeParse(event.payload);
          const eventId = z.uuid().safeParse(event.eventId);
          if (failure.success && eventId.success && failure.data.error.attribution.modelId === input.model) {
            quota = { source: "zcode", reason: "zCodePlanUsageExhausted", providerCode: failure.data.error.attribution.providerErrorCode,
              eventId: eventId.data, threadId, turnId: session.turnId };
          }
        }
        if (terminal === "completed") {
          const counts = providerUsage.safeParse(event.payload.usage).data;
          const eventId = z.uuid().safeParse(event.eventId).data;
          if (counts && eventId) usage = { source: "zcode_turn", nativeTurnId: nativeTurn, eventId,
            reportedRequests: counts.modelRequestCount, inputTokens: counts.inputTokens, outputTokens: counts.outputTokens };
          if ((!guided || !answer.trim()) && typeof event.payload.response === "string") {
            answer = event.payload.response.slice(0, 24_000);
          }
        }
        streaming = false;
        continue;
      }
      if (event.type === "model.streaming" && !signal.aborted) {
        const parsed = proposalSchema.safeParse(event.payload);
        if (parsed.success && tools.includes(parsed.data.toolName) && !priorCalls.has(parsed.data.toolCallId)) {
          const item = parsed.data;
          if (effects.has(item.toolCallId) || effects.size >= 64) throw new Error("ZCode repeated or exceeded its tool call range.");
          const schema = item.toolName === readName ? nativeReadInput : item.toolName === patchName ? patchSchema : todoInput;
          const args = schema.safeParse(item.input);
          if (args.success) effects.set(item.toolCallId, { ...item, input: args.data, digest: canonicalDigest(args.data), state: "proposed" });
        }
        if (event.payload.kind === "text_delta" && typeof event.payload.delta === "string") {
          answer += event.payload.delta.slice(0, Math.max(0, 24_000 - answer.length));
          publish(snapshot());
        }
      }
      if (event.type !== "tool.updated") continue;
      const parsed = toolUpdateSchema.safeParse(event.payload);
      if (!parsed.success) continue;
      const update = parsed.data;
      const effect = effects.get(update.toolCallId);
      if (!effect) continue;
      if (update.kind === "scheduled" && effect.state === "proposed" && update.toolName === effect.toolName &&
          update.assistantMessageId === effect.assistantMessageId) effect.state = "scheduled";
      else if (update.kind === "started" && effect.state === "scheduled" && update.toolName === effect.toolName) {
        effect.state = "started";
        if (effect.toolName !== todoName) {
          const read = effect.toolName === readName;
          const row = activeRow();
          effect.analysis = read ? undefined : activeAnalysis;
          effect.evidence = { tool: read ? "read_file" : "apply_patch", state: "running", assignment: session, nativeItemId: effect.toolCallId };
          if (row && row.evidence.length < 64 && (read || effect.analysis)) row.evidence.push(effect.evidence);
          ready.emit("started");
        }
      } else if (update.kind === "result" || update.kind === "error") {
        const complete = effect.state === "started" && update.result?.success === true;
        effect.state = "settled";
        if (effect.evidence) effect.evidence.state = complete && effect.outcome === true ? "succeeded" : "failed";
        if (effect.toolName === todoName && complete && !update.result?.truncated && !signal.aborted) {
          let plan: ReturnType<typeof reconcileNativeRows>;
          try {
            const todo = todoInput.parse(JSON.parse(update.result?.content ?? ""));
            if (canonicalDigest(todo) === effect.digest) plan = reconcileNativeRows(rows, todo.todos, session, { prefix: "zcode", titleKey: true, planOnly });
          } catch { /* The todo result must match the proposal before it can authorize the next operation. */ }
          acceptedPlan = !!plan;
          if (plan) rows = plan.rows;
          const active = activeRow()?.id === plan?.currentAnalysis?.rowId ? plan?.currentAnalysis : undefined;
          if (active?.rowId !== activeAnalysis?.rowId || active?.content !== activeAnalysis?.content) activeAnalysis = active;
          analysis = active?.summary ?? plan?.firstAnalysis ?? analysis;
        }
      }
      publish(snapshot());
    }
    if (followUp?.delivery === "queue" && !followUp.applied) {
      // ZCode can retain an unread guide after a stopped turn. Remove only that item.
      request(6, "v4/conversation/rowsRange", { sessionId: threadId, workspace, limit: 1, residency: "resident-only" });
      const { atRevision } = z.object({ atRevision: sequence }).parse(await receive(6));
      const commandId = randomUUID();
      v4Command(7, commandId, "deleteQueueItem", { queueItemId: followUp.queueItemId }, atRevision);
      commandAck.extend({ commandId: z.literal(commandId), status: z.literal("accepted") }).parse(await receive(7));
      followUp.resolve(false);
      followUp = undefined;
    }
    if (quota && !signal.aborted) return { ...snapshot(terminal), status: "blocked" as const, quota };
    return { ...snapshot(terminal), status: terminal };
  } finally {
    followUp?.resolve(false);
    if (onCancel) input.signal.removeEventListener("abort", onCancel);
    shutdown.abort();
    await Promise.all([mcp.close(), proxy?.close()]);
  }
}
