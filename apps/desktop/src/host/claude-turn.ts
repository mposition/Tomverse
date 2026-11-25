import { randomUUID } from "node:crypto";
import { normalize } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { safeLine, safeText } from "../../../tomverse-cli/src/display.js";
import { parseTaskAnalysis, type TaskAnalysis } from "../../../tomverse-cli/src/task-plan.js";
import { same, Workspace } from "../../../tomverse-cli/src/workspace.js";
import { asProposedCodePlan, MAX_CODE_PROMPT_CHARACTERS, type CodeNativeAssignment, type CodeNativeUsage, type CodeQuotaEvidence, type CodeTaskPlan } from "../contract";
import { initializeClaude, readCliFrames, type Frame } from "./cli-protocol";
import { bindClaudeRead, claudeReadInput, claudeReadReceipt } from "./claude-read";
import { claudeId as id, claudePatchProtocol, claudePatchServer, claudePatchToolName, type ClaudePatchProposal } from "./claude-patch-protocol";
import type { NativePatchTool } from "./native-patches";
import type { ProjectRoot } from "./project-root";

export const claudeReadOnlyTools = ["Read", "TaskCreate", "TaskUpdate"] as const;
const title = z.string().trim().min(1).max(160);
const phase = z.enum(["pending", "in_progress", "completed"]);
const initFrame = z.object({
  cwd: z.string(), model: id, permissionMode: z.enum(["plan", "default"]),
  tools: z.array(z.enum([...claudeReadOnlyTools, claudePatchToolName])).max(4),
  mcp_servers: z.array(z.object({ name: z.literal(claudePatchServer), status: z.literal("connected"), source: z.literal("sdk") })).max(1),
  slash_commands: z.array(z.never()).length(0),
  capabilities: z.array(z.string()).max(32).optional(),
});
const block = z.object({ type: z.string() }).passthrough();
const assistantFrame = z.object({ uuid: id, message: z.object({ model: id, content: z.array(block).max(24) }) });
const toolUse = z.object({ id, name: id, input: z.unknown() });
const toolResult = z.object({ tool_use_id: id, is_error: z.boolean().optional(), type: z.literal("tool_result") });
const userFrame = z.object({ message: z.object({ content: z.tuple([toolResult]) }), tool_use_result: z.unknown() });
const requestedCreate = z.object({ subject: title, description: z.unknown().optional() });
const createdTask = z.object({ task: z.object({ id, subject: title }) });
const requestedUpdate = z.object({ taskId: id, status: phase.optional(), subject: title.optional(), description: z.unknown().optional() });
const updatedTask = z.object({ success: z.literal(true), taskId: id, updatedFields: z.array(z.string()).max(24),
  statusChange: z.object({ from: phase, to: phase }).optional() });
const partialDelta = z.object({ type: z.literal("content_block_delta"), index: z.number().int().min(0).max(23),
  delta: z.object({ type: z.literal("text_delta"), text: z.string() }) });
const partialStart = z.object({ type: z.literal("content_block_start"), index: z.number().int().min(0).max(23),
  content_block: z.object({ type: z.literal("text") }) });
const instruction = z.object({ id: z.uuid(), text: z.string().trim().min(1).max(MAX_CODE_PROMPT_CHARACTERS) });
const replay = z.object({ isReplay: z.literal(true), message: z.object({ role: z.literal("user"),
  content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]) }) });
const interruptReceipt = z.object({ request_id: id, subtype: z.literal("success"),
  response: z.object({ still_queued: z.array(id).length(0), cancelled: z.array(id).max(16).optional() }) });
const resultFrame = z.object({ subtype: z.string(), is_error: z.boolean(), terminal_reason: z.string().optional() });
const resultUsage = z.object({ input_tokens: z.int().nonnegative(), output_tokens: z.int().nonnegative(),
  cache_read_input_tokens: z.int().nonnegative().nullish(), cache_creation_input_tokens: z.int().nonnegative().nullish() });
const subscriptionLimit = z.object({
  uuid: z.uuid(), rate_limit_info: z.object({ status: z.literal("rejected"), errorCode: z.literal("credits_required") }),
});
const limitResult = z.object({
  subtype: z.enum(["success", "error_during_execution"]), is_error: z.literal(true),
  terminal_reason: z.enum(["api_error", "blocking_limit"]), user_message_uuid: z.uuid(),
  queued_turn_count: z.literal(0).optional(), startup_failure_reason: z.never().optional(), deferred_tool_use: z.never().optional(),
  api_error_status: z.union([z.literal(402), z.literal(429)]).nullish(),
});
const limitNotice = z.object({
  error: z.enum(["rate_limit", "billing_error"]),
  message: z.object({ model: z.union([id, z.literal("<synthetic>")]),
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })).max(24) }),
});
const maxAnswer = 24_000;
const displayText = (text: string) => safeText(text.slice(0, maxAnswer)).slice(0, maxAnswer);
const phaseOrder = { pending: 0, in_progress: 1, completed: 2 };
type Evidence = { id: string; tool: "read_file" | "apply_patch"; state: "running" | "succeeded" | "failed";
  assignment: CodeNativeAssignment; call?: string; binding?: string };
type TurnAnalysis = { turnId: string; summary: TaskAnalysis };
type Row = { id: string; title: string; phase: z.infer<typeof phase>; assignment?: CodeNativeAssignment; evidence: Evidence[]; evidenceStart: number;
  analysis?: TurnAnalysis };
type Proposal =
  | { type: "create"; title: string; analysis?: TurnAnalysis }
  | { type: "update"; change: z.infer<typeof requestedUpdate>; analysis?: TurnAnalysis }
  | { type: "read"; item: Evidence }
  | ({ type: "patch"; item: Evidence } & ClaudePatchProposal)
  | { type: "unsupported" };

type ClaudeQuota = Extract<CodeQuotaEvidence, { source: "claude_code" }>;
export type ClaudeTurnObservation = { status: "running" | "completed" | "failed" | "interrupted" | "blocked"; session: CodeNativeAssignment;
  plan?: CodeTaskPlan; messages: Array<{ role: "user" | "assistant"; text: string }>; streamingAnswer?: string;
  pendingFollowUp?: string; unconfirmed?: true; quota?: ClaudeQuota; usage?: Extract<CodeNativeUsage, { source: "claude_turn" }> };
type QueueFollowUp = (id: string, text: string) => Promise<boolean>;
type FollowUp = z.infer<typeof instruction> & {
  queued: boolean; started: boolean; received: boolean; resolve: (confirmed: boolean) => void;
};

export async function observeClaudeFixtureTurn(child: { stdout: Readable; stdin: Writable },
  input: { project: ProjectRoot; sessionId: string; turnId: string; model: string; prompt: string; signal: AbortSignal;
    previousPlan?: CodeTaskPlan; patchTool?: NativePatchTool; planOnly?: boolean },
  publish: (observation: ClaudeTurnObservation) => void,
  registerFollowUp?: (queue: QueueFollowUp) => void,
): Promise<ClaudeTurnObservation> {
  const incoming = readCliFrames(child.stdout, 1024 * 1024);
  const send = (frame: Frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  let session: CodeNativeAssignment = { provider: "anthropic", threadId: input.sessionId, turnId: input.turnId, model: input.model };
  const workspace = new Workspace(input.project.path);
  const rows = new Map<string, Row>();
  const pending = new Map<string, Proposal>();
  const used = new Set<string>();
  const previousEvidence = new Set<string>();
  const permissionMode = input.patchTool ? "default" : "plan";
  const expectedTools = input.patchTool ? [...claudeReadOnlyTools, claudePatchToolName] as const : claudeReadOnlyTools;
  const patchProtocol = input.patchTool && claudePatchProtocol(input.patchTool, send, input.signal, (toolId) => {
    const proposal = pending.get(toolId);
    return proposal?.type === "patch" ? proposal : undefined;
  }, (error) => child.stdout.destroy(error));
  const messages: ClaudeTurnObservation["messages"] = [];
  const assistantFrames = new Set<string>();
  const limitEvents = new Set<string>();
  const commands = new Set([input.turnId]);
  let followUp: FollowUp | undefined;
  let preview: { index: number; text: string } | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let status: ClaudeTurnObservation["status"] = "running";
  let quota: ClaudeQuota | undefined;
  let usage: ClaudeTurnObservation["usage"];
  let initialized = false;
  let nextTurn = false;
  let followUpSupported = false;
  let publicStream = false;
  let interruptId: string | undefined;
  let interruptAcknowledged = false;
  for (const item of input.previousPlan?.items ?? []) {
    const taskId = item.id.slice("claude-".length);
    if (!item.nativeStatus || !item.id.startsWith("claude-") || rows.has(taskId)) throw new Error("Invalid saved Claude task.");
    const evidence: Evidence[] = item.evidence.map(({ tool, state, nativeItemId, assignment, nativeCallId, nativeReadBinding }) => {
      if ((state !== "succeeded" && state !== "failed") || !nativeItemId || !assignment || !("threadId" in assignment) ||
          assignment.threadId !== input.sessionId || assignment.model !== input.model || assignment.provider !== "anthropic" ||
          previousEvidence.has(nativeItemId) || (tool !== "read_file" && !(input.patchTool && tool === "apply_patch"))) {
        throw new Error("Invalid saved Claude task evidence.");
      }
      previousEvidence.add(nativeItemId);
      return { id: nativeItemId, tool, state, assignment, call: nativeCallId, binding: nativeReadBinding };
    });
    rows.set(taskId, { id: item.id, title: item.title, phase: item.nativeStatus, assignment: item.nativeAssignment, evidence,
      evidenceStart: item.nativeStatus === "completed" ? item.evidenceStart ?? 0 : evidence.length });
  }
  const activeRow = () => {
    const active = [...rows.values()].filter((row) => row.phase === "in_progress");
    return active.length === 1 ? active[0] : undefined;
  };
  const analyzedRow = () => {
    const row = activeRow();
    return !followUp && row?.analysis?.turnId === session.turnId ? row : undefined;
  };
  const publicAnalysis = () => {
    const row = activeRow() ?? [...rows.values()].findLast(({ analysis }) => analysis?.turnId === session.turnId);
    return row?.analysis?.turnId === session.turnId ? row.analysis.summary : undefined;
  };
  const snapshotPlan = (): CodeTaskPlan | undefined => {
    if (!rows.size) return;
    const plan: CodeTaskPlan = {
      activeId: status === "running" ? activeRow()?.id ?? null : null,
      analysis: publicAnalysis(),
      items: [...rows.values()].map((row) => {
        const current = row.evidence.slice(row.evidenceStart);
        const complete = row.phase === "completed" && current.length > 0 && current.every(({ state }) => state === "succeeded");
        return { id: row.id, title: row.title, nativeAssignment: row.assignment, nativeStatus: row.phase, complete, evidenceStart: row.evidenceStart,
          cancelled: status === "interrupted" && (input.planOnly || row.phase !== "completed"),
          completionUnverified: row.phase === "completed" && !complete,
          evidence: row.evidence.map((item) => ({ tool: item.tool, state: status !== "running" && item.state === "running" ? "unconfirmed" : item.state,
            assignment: item.assignment, nativeItemId: item.id, nativeCallId: item.call, nativeReadBinding: item.binding })),
        };
      }),
    };
    return input.planOnly ? asProposedCodePlan(plan) : plan;
  };
  const snapshot = (): ClaudeTurnObservation => ({
    status, session, messages: [...messages], quota: status === "blocked" ? quota : undefined, usage,
    pendingFollowUp: followUp?.queued ? displayText(followUp.text) : undefined,
    streamingAnswer: status === "running" && !input.signal.aborted && preview?.text ? displayText(preview.text) : undefined,
    unconfirmed: status !== "running" && (pending.size > 0 || followUp) ? true : undefined,
    plan: snapshotPlan(),
  });
  const update = () => {
    clearTimeout(previewTimer);
    previewTimer = undefined;
    publish(snapshot());
  };
  const sendInstruction = (turnId: string, text: string) => send({
    type: "user", session_id: input.sessionId, uuid: turnId, parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text }] },
  });
  const confirmFollowUp = () => {
    if (nextTurn || !followUp?.queued || !followUp.started || !followUp.received || input.signal.aborted) return;
    const delivered = followUp;
    followUp = undefined;
    quota = undefined;
    usage = undefined;
    session = { ...session, turnId: delivered.id, reportedModel: undefined };
    for (const row of rows.values()) {
      if (row.phase !== "in_progress") continue;
      row.assignment = session;
      row.evidenceStart = row.evidence.length;
    }
    messages.push({ role: "user", text: displayText(delivered.text) });
    delivered.resolve(true);
  };
  const track = (item: Evidence) => {
    const row = activeRow();
    if (row) {
      if (row.evidence.length >= 64) throw new Error("Claude Code exceeded the task evidence limit.");
      row.evidence.push(item);
    }
    return item;
  };
  const analysisFor = (description: unknown): TurnAnalysis | undefined => {
    const summary = !followUp && parseTaskAnalysis(description);
    return summary ? { turnId: session.turnId, summary } : undefined;
  };
  const propose = (use: z.infer<typeof toolUse>, call: string): Proposal => {
    if (use.name === "TaskCreate") {
      const requested = requestedCreate.safeParse(use.input);
      if (requested.success) return { type: "create", title: safeLine(requested.data.subject),
        analysis: analysisFor(requested.data.description) };
    } else if (use.name === "TaskUpdate") {
      const requested = requestedUpdate.safeParse(use.input);
      if (requested.success) return { type: "update", change: requested.data,
        analysis: analysisFor(requested.data.description) };
    } else if (use.name === "Read") {
      const requested = claudeReadInput.safeParse(use.input);
      if (requested.success) {
        const item = track({ id: use.id, tool: "read_file", state: "running", assignment: session, call,
          binding: bindClaudeRead(workspace, input.project, requested.data.file_path) });
        return { type: "read", item };
      }
    } else if (patchProtocol && use.name === claudePatchToolName) {
      const row = analyzedRow();
      const analysis = row?.analysis;
      const item: Evidence = { id: use.id, tool: "apply_patch", state: "running", assignment: session, call };
      if (row) track(item);
      return { type: "patch", input: use.input, item,
        canApply: () => !!row && row.analysis === analysis && analyzedRow() === row };
    }
    return { type: "unsupported" };
  };
  const applyReceipt = (proposal: Proposal, receipt: unknown, rejected: boolean) => {
    if (proposal.type === "patch") {
      if (!proposal.result ? !rejected || proposal.dispatched : proposal.result.success === rejected) {
        throw new Error("Claude Code reported an unconfirmed Desktop patch result.");
      }
      proposal.item.state = rejected ? "failed" : "succeeded";
      return;
    }
    if (rejected) {
      if (proposal.type === "read") proposal.item.state = "failed";
      return;
    }
    if (proposal.type === "unsupported") throw new Error("Claude Code reported an unsupported tool as successful.");
    if (proposal.type === "read") {
      const confirmed = claudeReadReceipt.safeParse(receipt);
      const actual = confirmed.success ? bindClaudeRead(workspace, input.project, confirmed.data.file.filePath) : undefined;
      if (!confirmed.success || !actual || actual !== proposal.item.binding) {
        throw new Error("Claude Code did not confirm a read in the bound workspace.");
      }
      // A cached result refers to an earlier read and cannot verify revised work.
      proposal.item.state = confirmed.data.type === "file_unchanged" ? "failed" : "succeeded";
      return;
    }
    if (proposal.type === "create") {
      const confirmed = createdTask.safeParse(receipt);
      if (!confirmed.success || safeLine(confirmed.data.task.subject) !== proposal.title || rows.has(confirmed.data.task.id)) return;
      if (rows.size >= 24) throw new Error("Claude Code exceeded the fixture task limit.");
      const taskId = confirmed.data.task.id;
      rows.set(taskId, { id: `claude-${taskId}`, title: proposal.title, phase: "pending", evidence: [], evidenceStart: 0,
        analysis: proposal.analysis });
      return;
    }
    const confirmed = updatedTask.safeParse(receipt);
    const change = proposal.change;
    const row = rows.get(change.taskId);
    if (!confirmed.success || confirmed.data.taskId !== change.taskId || !row) return;
    const { updatedFields, statusChange } = confirmed.data;
    if (change.description !== undefined && updatedFields.includes("description")) row.analysis = proposal.analysis;
    const canRevise = !!input.previousPlan || session.turnId !== input.turnId;
    const revised = canRevise && row.assignment?.turnId !== session.turnId;
    const rename = change.subject && updatedFields.includes("subject") ? safeLine(change.subject) : undefined;
    const reset = () => {
      row.evidenceStart = row.evidence.length;
      row.assignment = session;
    };
    if (rename && rename !== row.title) {
      row.title = rename;
      reset();
    }
    if (change.status && updatedFields.includes("status") && statusChange?.from === row.phase && statusChange.to === change.status &&
        (phaseOrder[change.status] >= phaseOrder[row.phase] || canRevise)) {
      if (phaseOrder[change.status] < phaseOrder[row.phase] || revised) reset();
      row.phase = change.status;
      if (row.phase === "in_progress") row.assignment = session;
    }
  };
  const interrupt = () => {
    interruptId = randomUUID();
    send({ type: "control_request", request_id: interruptId, request: { subtype: "interrupt", cancel_queued: true } });
  };

  input.signal.throwIfAborted();
  await initializeClaude({ send, read: async (match) => {
    for (;;) {
      const next = await incoming.next();
      if (next.done) break;
      if (match(next.value)) return next.value;
      if (!patchProtocol || next.value.type !== "control_request") break;
      patchProtocol.receive(next.value);
    }
    throw new Error("Claude Code did not initialize the fixture.");
  } }, permissionMode);
  input.signal.throwIfAborted();
  sendInstruction(input.turnId, instruction.parse({ id: input.turnId, text: input.prompt }).text);
  registerFollowUp?.((requestId, text) => {
    const data = instruction.safeParse({ id: requestId, text });
    if (!data.success || !followUpSupported || nextTurn || status !== "running" || input.signal.aborted || followUp ||
        commands.size >= 9 || commands.has(requestId) || !child.stdin.writable) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      commands.add(requestId);
      followUp = { ...data.data, queued: false, started: false, received: false, resolve };
      sendInstruction(requestId, data.data.text);
    });
  });
  input.signal.addEventListener("abort", interrupt, { once: true });
  try {
    for await (const frame of incoming) {
      if (frame.type === "control_response" && interruptId) {
        const receipt = interruptReceipt.safeParse(frame.response);
        if (receipt.success && receipt.data.request_id === interruptId) {
          if (followUp && receipt.data.response.cancelled?.includes(followUp.id)) {
            followUp.resolve(false);
            followUp = undefined;
          }
          interruptAcknowledged = true;
        }
        continue;
      }
      if (frame.type === "control_request" || frame.type === "control_cancel_request") {
        if (!patchProtocol) throw new Error("A Claude Code fixture requested an unexpected approval.");
        patchProtocol.receive(frame);
        continue;
      }
      if (frame.session_id !== input.sessionId || frame.parent_tool_use_id || frame.agent_id) continue;
      if (frame.type === "command_lifecycle") {
        if (followUp && frame.command_uuid === followUp.id) {
          if (frame.state === "queued") followUp.queued = true;
          if (frame.state === "started") followUp.started = true;
          confirmFollowUp();
          update();
        }
        continue;
      }
      if (frame.type === "system" && frame.permissionMode && frame.permissionMode !== permissionMode) {
        throw new Error("Claude Code changed its permission mode.");
      }
      if (frame.type === "system" && frame.subtype === "init") {
        const init = initFrame.parse(frame);
        if ((initialized && !(nextTurn && followUp?.started)) || init.model !== input.model || init.permissionMode !== permissionMode ||
            init.tools.length !== expectedTools.length || !expectedTools.every((tool) => init.tools.includes(tool)) ||
            init.mcp_servers.length !== (patchProtocol ? 1 : 0) ||
            !same(normalize(init.cwd), normalize(input.project.path))) {
          throw new Error("Claude Code initialized an unexpected workspace.");
        }
        initialized = true;
        nextTurn = false;
        const priorActive = activeRow();
        if (input.previousPlan && priorActive) priorActive.assignment = session;
        followUpSupported = !!init.capabilities?.includes("interrupt_cancel_queued_v1") &&
          init.capabilities.includes("msg_lifecycle_v1");
        confirmFollowUp();
      } else if (!initialized || (nextTurn && !input.signal.aborted)) {
        throw new Error("Claude Code did not confirm the fixture session before execution.");
      } else if (frame.type === "rate_limit_event") {
        const rejected = subscriptionLimit.safeParse(frame);
        if (rejected.success && frame.isReplay !== true) {
          const eventId = rejected.data.uuid;
          if (limitEvents.has(eventId)) continue;
          if (limitEvents.size >= 64) throw new Error("Claude Code exceeded its fixture quota event limit.");
          limitEvents.add(eventId);
          quota = !pending.size && !followUp ? {
            source: "claude_code", reason: "credits_required", threadId: session.threadId, turnId: session.turnId, eventId,
          } : undefined;
        } else {
          quota = undefined;
        }
        continue;
      } else if (frame.type === "system" && frame.subtype === "api_retry") {
        quota = undefined;
        continue;
      } else if (frame.type === "stream_event") {
        const event = block.safeParse(frame.event);
        if (!event.success) continue;
        if (event.data.type === "message_start") {
          preview = undefined;
          const started = z.object({ model: id }).safeParse(event.data.message);
          publicStream = started.success && started.data.model === input.model;
          if (publicStream) quota = undefined;
        }
        const start = partialStart.safeParse(frame.event);
        if (publicStream && start.success && !input.signal.aborted) preview = { index: start.data.index, text: "" };
        const delta = partialDelta.safeParse(frame.event);
        if (publicStream && delta.success && preview?.index === delta.data.index && !input.signal.aborted) {
          preview.text += delta.data.delta.text.slice(0, maxAnswer - preview.text.length);
          previewTimer ??= setTimeout(update, 48);
        }
        continue;
      } else if (frame.type === "assistant") {
        const notice = quota && frame.aborted !== true && limitNotice.safeParse(frame);
        // A terminal provider notice can use a synthetic model. Its text is not a quota receipt.
        if (notice && notice.success && (notice.data.message.model === "<synthetic>" || notice.data.message.model === input.model)) continue;
        const data = assistantFrame.parse(frame);
        if (data.message.model !== input.model) throw new Error("Claude Code reported an unexpected model.");
        if (assistantFrames.has(data.uuid)) continue;
        if (assistantFrames.size >= 64) throw new Error("Claude Code exceeded its fixture response limit.");
        assistantFrames.add(data.uuid);
        session = { ...session, reportedModel: { model: data.message.model, source: "claude_assistant" } };
        quota = undefined;
        for (const content of data.message.content) {
          if (content.type === "text" && typeof content.text === "string") {
            preview = undefined;
            if (messages.length < 32) messages.push({ role: "assistant", text: displayText(content.text) });
          } else if (content.type === "tool_use") {
            const use = toolUse.parse(content);
            if (used.has(use.id) || previousEvidence.has(use.id)) continue;
            if (used.size >= 64) throw new Error("Claude Code exceeded its fixture tool limit.");
            used.add(use.id);
            pending.set(use.id, propose(use, data.uuid));
          }
        }
      } else if (frame.type === "user") {
        if (followUp && frame.uuid === followUp.id && frame.isReplay === true) {
          if (replay.parse(frame).message.content[0].text !== followUp.text) throw new Error("Claude Code received a different instruction.");
          followUp.received = true;
          confirmFollowUp();
          update();
          continue;
        }
        const parsed = userFrame.safeParse(frame);
        if (!parsed.success) continue;
        const [receipt] = parsed.data.message.content;
        const proposal = pending.get(receipt.tool_use_id);
        if (!proposal) continue;
        applyReceipt(proposal, parsed.data.tool_use_result, receipt.is_error === true);
        pending.delete(receipt.tool_use_id);
      } else if (frame.type === "result") {
        const result = resultFrame.parse(frame);
        if (interruptAcknowledged && ["interrupted", "aborted_streaming", "aborted_tools"].includes(result.terminal_reason ?? "")) {
          status = "interrupted";
        } else if (quota?.turnId === session.turnId && frame.user_message_uuid === session.turnId &&
            !input.signal.aborted && !pending.size && !followUp && limitResult.safeParse(frame).success) {
          status = "blocked";
        } else {
          status = result.subtype === "success" && !result.is_error && result.terminal_reason === "completed" ? "completed" : "failed";
        }
        if (status === "completed" && frame.user_message_uuid === session.turnId) {
          const counters = resultUsage.safeParse(frame.usage);
          if (counters.success) {
            const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = counters.data;
            usage = { source: "claude_turn", inputTokens: input_tokens, outputTokens: output_tokens,
              cacheReadTokens: cache_read_input_tokens ?? undefined, cacheWriteTokens: cache_creation_input_tokens ?? undefined };
          }
        }
        preview = undefined;
        if (status === "completed" && followUp && !input.signal.aborted && !pending.size && !nextTurn) {
          status = "running";
          nextTurn = true;
          update();
          continue;
        }
        update();
        return snapshot();
      } else {
        continue;
      }
      update();
    }
    throw new Error("Claude Code exited without a confirmed result.");
  } catch (error) {
    status = "failed";
    update();
    throw error;
  } finally {
    clearTimeout(previewTimer);
    input.signal.removeEventListener("abort", interrupt);
    followUp?.resolve(false);
    await patchProtocol?.close();
  }
}
