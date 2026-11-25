import { codeReferenceKind, codeReferencePath, MAX_CODE_REFERENCES, type Change, type CodeQuotaEvidence, type CommandInspection, type Entry, type RunStatus,
  type CodeTaskPlan, type Task, type Transmission, type Verification } from "../contract";
import { VIEW_IMAGE_MARK, estimateTokens, hasUnconfirmedToolOutcome, historyBlockReason, safeText, type SessionState } from "../../../tomverse-cli/src/runtime.js";
import { isEffort } from "../../../tomverse-cli/src/effort.js";
import { confirmedApiQuota } from "../../../tomverse-cli/src/quota-refusal.js";
import { reportedGenerationModel } from "../../../tomverse-cli/src/transmission.js";
import { canComplete, taskAnalysisSchema, taskPlanAssignmentsSchema, taskPlanSchema,
  type TaskAnalysis, type TaskPlanEvidence } from "../../../tomverse-cli/src/task-plan.js";

const credentialPattern = /tvk_[A-Za-z0-9_-]{12,}/;

export function hasCredential(text: string, key: string): boolean {
  return text.includes(key) || credentialPattern.test(text);
}

export function cleanText(text: string, key?: string) {
  const withoutKey = key ? text.replaceAll(key, "[credential removed]") : text;
  return safeText(withoutKey.replace(/tvk_[A-Za-z0-9_-]{12,}/g, "[credential removed]"));
}

export function cleanPlanAnalysis(analysis: TaskAnalysis | undefined, key?: string): TaskAnalysis | undefined {
  if (!analysis) return undefined;
  const clean = (text: string) => cleanText(text, key).slice(0, 480).trim();
  return taskAnalysisSchema.safeParse({
    objective: clean(analysis.objective), verifiedFacts: analysis.verifiedFacts.map(clean).filter(Boolean),
    assumptions: analysis.assumptions.map(clean).filter(Boolean), scope: clean(analysis.scope),
    verification: clean(analysis.verification), completion: clean(analysis.completion),
  }).data;
}

export function journalEntries(state: SessionState, key?: string): Entry[] {
  const plan = taskPlanSchema.safeParse(state.tasks.at(-1)?.plan);
  const start = Math.max(0, state.messages.length - 80);
  const compacted = state.compactions.length > 0;
  const original = state.tasks[0];
  const userEntry = (text: string): Entry => ({ role: "user", text: cleanText(text.slice(0, 24_000), key) });
  const earlier = state.tasks.flatMap((task) => (task.followUps ?? [])
    .filter(({ messageIndex }) => messageIndex === null || (messageIndex !== undefined && messageIndex < start))
    .map(({ text }) => userEntry(text)));
  if ((compacted || start > 0) && original) earlier.unshift(userEntry(original.prompt));
  const entries = [...earlier, ...state.messages.slice(start).flatMap((message, index): Entry[] => {
    if (compacted && start + index === 0) return [];
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = message.role === "user" && start + index === 0 && original && (original.references?.length || state.codeContinuation)
      ? original.prompt : typeof message.content === "string"
      ? message.content
      : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    // An image the agent looked at is attached on its behalf as a message of the user's role; it is not something the person wrote.
    if (message.role === "user" && text.startsWith(VIEW_IMAGE_MARK)) return [];
    const visible: Entry[] = text ? [{ role: message.role, text: cleanText(text.slice(0, 24_000), key) }] : [];
    if (plan.success && message.role === "assistant" && Array.isArray(message.content) && message.content.some((part) =>
      part.type === "tool-call" && part.toolName === "update_task_plan" && part.toolCallId === plan.data.firstCallId)) visible.push({ role: "plan" });
    return visible;
  })];
  if (plan.success && !entries.some((entry) => entry.role === "plan")) {
    const introduction = entries.findIndex((entry) => entry.role === "assistant");
    entries.splice(introduction < 0 ? entries.length : introduction + 1, 0, { role: "plan" });
  }
  return markTurns(entries, state);
}

/**
 * Marks the user entries that are turns of the saved task, in order, by the text the session recorded for each. An entry that is not
 * one (a continuation goal mode wrote, a note) stays unmarked, and so does anything that cannot be matched.
 */
export function markTurns<T extends Entry>(entries: T[], state: Pick<SessionState, "checkpoints">): T[] {
  let at = 0;
  (state.checkpoints ?? []).forEach((mark, turn) => {
    for (let index = at; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.role !== "user" || !entry.text.startsWith(mark.text.slice(0, 160))) continue;
      entry.turn = turn;
      at = index + 1;
      return;
    }
  });
  return entries;
}

/** Whether a saved task can be taken back to a turn or forked: it has turns and nothing about it is running or unknown. */
export function canRewindJournal(state: SessionState): true | undefined {
  return !!state.checkpoints?.length && !historyBlockReason(state) && journalStatus(state) !== "unknown" ? true : undefined;
}

export function journalPendingFollowUp(state: SessionState, key?: string): string | undefined {
  const latest = state.tasks.at(-1)?.followUps?.at(-1);
  return latest && latest.messageIndex === undefined ? cleanText(latest.text, key) : undefined;
}

/** Limits, goal mode and held messages of a saved task: cheap, so it is read on every publish. */
export function journalEngine(state: SessionState, key?: string): Pick<Task, "limits" | "goal" | "queued" | "subagents"> {
  const task = state.tasks.at(-1);
  const profile = state.limits.profile;
  const last = task?.goalChecks?.at(-1);
  return {
    limits: profile === "extended" || profile === "unlimited" ? profile : undefined,
    goal: state.goal ? {
      maxContinuations: state.goal.maxContinuations, continuations: task?.goalContinuations ?? 0,
      ...(last ? { last: { met: last.met, summary: cleanText(last.summary, key), ...(last.next ? { next: cleanText(last.next, key) } : {}) } } : {}),
    } : undefined,
    queued: task?.queued?.length ? task.queued.map(({ id, text }) => ({ id, text: cleanText(text.slice(0, 24_000), key) })) : undefined,
    subagents: journalSubagents(state, key),
  };
}

/** The subagents of a session for the Code screen. A run still marked running in a session that is not running is one whose result is not known. */
export function journalSubagents(state: SessionState, key?: string): Task["subagents"] {
  const list = state.subagents;
  if (!list?.length) return undefined;
  const live = state.status === "running";
  return list.slice(-12).map((record) => ({
    id: record.id, kind: record.kind, task: cleanText(record.task, key).slice(0, 300), requests: record.requests,
    state: record.state === "running" && !live ? "unknown" as const : record.state,
    ...(record.summary ? { summary: cleanText(record.summary, key).slice(0, 400) } : {}),
  }));
}

/** A rough size of the saved conversation: it walks every message, so it is read when a request ends, not on every publish. */
export function journalContext(state: SessionState): Task["context"] {
  return { tokens: estimateTokens(state.messages), window: state.model.contextWindowTokens || 128_000 };
}

export function journalPlan(state: Pick<SessionState, "tasks" | "generations" | "id" | "codeContinuation" | "codeMode" | "readOnly">,
  key?: string): CodeTaskPlan | undefined {
  const task = state.tasks.at(-1);
  const plan = taskPlanSchema.safeParse(task?.plan);
  if (!plan.success) return undefined;
  const proposedOnly = (state.codeMode ?? (state.readOnly ? "plan" : "agent")) === "plan";
  const generations = new Map(state.generations.map((generation) => [generation.seq, generation]));
  const recorded = taskPlanAssignmentsSchema.safeParse(task?.planAssignments).data;
  const assignments = new Map(!proposedOnly && recorded?.revision === plan.data.revision ? recorded.rows.map((row) => [row.id, row]) : []);
  const observeModel = (assignment: NonNullable<TaskPlanEvidence["assignment"]>) => {
    const generation = generations.get(assignment.requestSeq);
    const actual = generation && reportedGenerationModel(generation);
    return {
      assignment: { ...assignment, model: cleanText(assignment.model, key) },
      ...(actual && actual !== "smart-adaptive" ? { reportedModel: {
        model: cleanText(actual.slice(0, 160), key),
        source: generation.routedModel ? "api_header" as const : "api_receipt" as const,
      } } : {}),
      appliedEffort: generation?.appliedEffort,
    };
  };
  return { activeId: proposedOnly ? null : plan.data.activeId, ...(proposedOnly ? { proposalOnly: true as const } : {}),
    analysis: cleanPlanAnalysis(plan.data.analysis, key), items: plan.data.items.map((item) => {
      const recorded = assignments.get(item.id);
      const generation = recorded && generations.get(recorded.assignment.requestSeq);
      const apiAssignment = recorded?.title === item.title && recorded.assignment.model !== "smart-adaptive" &&
        generation?.purpose === "agent" && generation.httpStatus && generation.httpStatus < 400 &&
        (plan.data.analysis || item.complete || item.cancelled) ? observeModel(recorded.assignment) : undefined;
      return {
        id: item.id, title: cleanText(item.title, key), complete: !proposedOnly && item.complete && !item.cancelled && canComplete(item.evidence, item.evidenceStart),
        segmentId: state.codeContinuation?.segmentId ?? state.id, ...(apiAssignment ? { apiAssignment } : {}),
        evidenceStart: proposedOnly ? undefined : item.evidenceStart,
        cancelled: item.cancelled, evidence: proposedOnly ? [] : item.evidence.map(({ tool, state, assignment }) => ({
          tool, state, ...(assignment ? observeModel(assignment) : {}),
        })),
      };
    }),
  };
}

export function journalReferences(state: SessionState, key?: string) {
  const references = state.tasks[0]?.references;
  if (!Array.isArray(references)) return [];
  return references.slice(0, MAX_CODE_REFERENCES).flatMap((reference) => {
    const kind = codeReferenceKind.safeParse(reference?.kind);
    const path = codeReferencePath.safeParse(reference?.path);
    return kind.success && path.success ? [{ kind: kind.data, path: cleanText(path.data, key) }] : [];
  });
}

export function journalStatus(state: SessionState): RunStatus {
  if (state.changes.some((change) => change.state === "writing") || state.tools.some(hasUnconfirmedToolOutcome)) return "unknown";
  switch (state.status) {
    case "completed":
      return taskPlanSchema.safeParse(state.tasks.at(-1)?.plan).data?.clarification ? "clarification" : "completed";
    case "cancelled": return "stopped";
    case "unknown_outcome": return "unknown";
    case "error": return journalQuota(state) ? "blocked" : "failed";
    case "idle":
    case "running": return "unknown";
    default: return "blocked";
  }
}

export function journalQuota(state: SessionState): CodeQuotaEvidence | undefined {
  if (state.status !== "error" || state.pendingApprovals.length || state.pendingResendOf !== undefined ||
      state.changes.some(({ state }) => state === "writing") || state.tools.some(hasUnconfirmedToolOutcome) ||
      state.generations.some(({ closed }) => closed !== true)) return undefined;
  const quota = confirmedApiQuota(state.generations.at(-1));
  return quota && { source: "tomverse_api", ...quota };
}

export function canContinueApiQuota(state: SessionState, requestId: string, readOnly: boolean): boolean {
  const quota = journalQuota(state);
  return state.readOnly === readOnly && !state.codeContinuation && (!readOnly || !state.changes.length) && !journalPendingFollowUp(state) &&
    quota?.source === "tomverse_api" && quota.requestId === requestId && receiptsReconciled(state);
}

function receiptsReconciled(state: SessionState): boolean {
  return state.generations.every((generation) => {
    if (confirmedApiQuota(generation)) return true;
    const { receipt } = generation;
    return generation.lookup === "found" && !!receipt && receipt.requestId === generation.requestId &&
      (receipt.status === "settled" || receipt.status === "released") &&
      typeof receipt.chargedCredits === "number" && Number.isFinite(receipt.chargedCredits) && receipt.chargedCredits >= 0;
  });
}

function canRunSavedTask(state: SessionState): boolean {
  const task = state.tasks.at(-1);
  return !!task && task.requests < task.allowance && task.activeMs < task.timeAllowanceMs &&
    !state.pendingApprovals.length && state.pendingResendOf === undefined && state.generations.every((record) => record.closed) &&
    // An approval recorded before Stop may never have reached its tool. Do not carry it into a new run.
    state.approvals.every((approval) => approval.decision !== "approved" || state.tools.some((tool) =>
      tool.toolCallId === approval.toolCallId && tool.toolName === approval.toolName && tool.inputDigest === approval.inputDigest));
}

export function canResumeJournal(state: SessionState): boolean {
  return !state.codeContinuation && !state.readOnly && state.tasks.at(-1)?.status === "cancelled" &&
    journalStatus(state) === "stopped" && canRunSavedTask(state);
}

export function canAnswerClarification(state: SessionState): boolean {
  return !state.codeContinuation && state.tasks.at(-1)?.status === "completed" && journalStatus(state) === "clarification" &&
    !journalPendingFollowUp(state) && canRunSavedTask(state);
}

export function canResumeQuotaJournal(state: SessionState): boolean {
  return state.tasks.at(-1)?.status === "error" && !!journalQuota(state) && !journalPendingFollowUp(state) &&
    canRunSavedTask(state) && receiptsReconciled(state);
}

export function journalChanges(state: SessionState): Change[] {
  const rows: Change[] = state.changes.map((change) => ({
    id: change.changeId, path: cleanText(change.path), kind: change.kind, current: change.state,
  }));
  const outcomes: Change[] = [];
  state.tools.forEach((tool, toolIndex) => {
    if (tool.toolName !== "apply_patch" || !tool.output || typeof tool.output !== "object" ||
        !("files" in tool.output) || !Array.isArray(tool.output.files)) return;
    tool.output.files.forEach((file, fileIndex) => {
      if (typeof file?.path !== "string" || typeof file?.action !== "string" ||
          !["failed", "not_attempted"].includes(file?.status)) return;
      if (state.changes.some((change) => change.toolCallId === tool.toolCallId && change.path === file.path)) return;
      outcomes.push({ id: `result-${toolIndex}-${fileIndex}`, path: cleanText(file.path), kind: file.action, current: file.status });
    });
  });
  return [...rows.slice(-80), ...outcomes.slice(-80)];
}

export function journalApiUsage(state: Pick<SessionState, "id" | "codeContinuation" | "generations">, key?: string):
  Required<Pick<Task, "transmission" | "apiUsage">> {
  const segmentId = state.codeContinuation?.segmentId ?? state.id;
  const apiUsage = { requestCount: state.generations.length, settled: 0, held: 0, unknown: 0 };
  for (const generation of state.generations) {
    const receipt = transmissionReceipt(generation);
    if (receipt.status === "held") apiUsage.held += receipt.credits;
    else if (receipt.status === "settled") apiUsage.settled += receipt.credits;
    else if (receipt.status === "unknown") apiUsage.unknown++;
  }
  const transmission = state.generations.slice(-80).map((generation): Transmission => {
    const quota = confirmedApiQuota(generation);
    return {
      segmentId, requestId: generation.requestId && /^req_[0-9a-f]{32}$/.test(generation.requestId) ? generation.requestId : undefined,
      quota: quota && { source: "tomverse_api", ...quota },
      seq: generation.seq, purpose: generation.purpose, state: generation.state,
      model: cleanText(reportedGenerationModel(generation) ?? "", key).slice(0, 160) || undefined,
      catalogProvider: typeof generation.catalogProvider === "string" ? cleanText(generation.catalogProvider, key).slice(0, 40) : undefined,
      httpStatus: generation.httpStatus, appliedEffort: isEffort(generation.appliedEffort) ? generation.appliedEffort : undefined,
      receipt: transmissionReceipt(generation), receiptNotFound: generation.lookup === "not_found" || undefined, contents: generation.transmission,
    };
  });
  return { apiUsage, transmission };
}

function transmissionReceipt(generation: SessionState["generations"][number]): Transmission["receipt"] {
  const receipt = generation.receipt;
  if (!receipt || !generation.requestId || receipt.requestId !== generation.requestId) return { status: "unknown" };
  const { status } = receipt;
  if (status !== "held" && status !== "settled" && status !== "released") return { status: "unknown" };
  const credits = status === "held" ? receipt.heldCredits : receipt.chargedCredits;
  return typeof credits === "number" && Number.isSafeInteger(credits) && credits >= 0 ? { status, credits } : { status: "unknown" };
}

export function journalChecks(state: SessionState): Verification[] {
  return state.tools.flatMap((tool, index) => {
    if (tool.toolName !== "run_command") return [];
    const output = tool.output;
    const exitCode = output && typeof output === "object" && "exitCode" in output ? output.exitCode : undefined;
    const status = hasUnconfirmedToolOutcome(tool) ? "unconfirmed" : output && typeof output === "object" && "status" in output ? output.status : undefined;
    return [{ id: `command-${index}`, tool: tool.toolName, state: typeof status === "string" ? status : tool.state,
      ...(typeof exitCode === "number" ? { exitCode } : {}) }];
  }).slice(-80);
}

export function journalCommand(state: SessionState, id: string): CommandInspection | null {
  const index = /^command-(\d+)$/.exec(id)?.[1];
  const tool = index === undefined ? undefined : state.tools[Number(index)];
  if (tool?.toolName !== "run_command") return null;
  const command = tool.command;
  const output = tool.output && typeof tool.output === "object" ? tool.output as Record<string, unknown> : {};
  const omitted = output.omittedBytes && typeof output.omittedBytes === "object" ? output.omittedBytes as Record<string, unknown> : {};
  const text = (value: unknown) => typeof value === "string" ? cleanText(value.replaceAll("\r\n", "\n")) : "";
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  return {
    ...(command ? { command: { ...command, file: text(command.file), cwd: text(command.cwd),
      args: command.args.map(text), envNames: command.envNames.map(text) } } : {}),
    stdout: text(output.stdout), stderr: text(output.stderr),
    error: text(output.error) || undefined, signal: text(output.signal) || undefined,
    elapsedMs: count(output.durationMs),
    stdoutOmitted: count(omitted.stdout) ?? 0, stderrOmitted: count(omitted.stderr) ?? 0,
  };
}
