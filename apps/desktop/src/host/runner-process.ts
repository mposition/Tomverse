import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, type Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  ApprovalMemory, GOAL_MAX_CONTINUATIONS, Gateway, Journal, RewindError, Runner, UndoError, Workspace, canUndoChange, createSession, deleteSession, forkSession,
  planRewind, readProjectInstructions, reconcile, renderChange, rewindSession, resolveEndpoint, resolveLimits, same, sessionCost, sha256, undoChange, validateSession, viewChange, withWorkspaceReferences,
  type ApprovalView, type CatalogModel, type Output, type WorkspaceReference,
} from "../../../tomverse-cli/src/runtime.js";
import { claimLock, SessionLockedError } from "../../../tomverse-cli/src/session.js";
import { pathIdentity } from "../../../tomverse-cli/src/patch.js";
import { asProposedCodePlan, sessionId as taskIdSchema, type QueueOperation, type ApprovalRequest, type ChangeInspection, type CodeNativeRecoverySummary,
  type CodeNativeUsage, type Decision, type Task } from "../contract";
import { antigravityFixtureExecution, claudeFixtureExecution, codexFixtureExecution, codeRouteFor, kimiFixtureExecution, qwenFixtureExecution, tomverseApiExecution, vibeFixtureExecution, deepSeekFixtureExecution, zCodeFixtureExecution, miniMaxFixtureExecution, grokFixtureExecution } from "../code-execution";
import { canAnswerClarification, canContinueApiQuota, canRewindJournal, markTurns, canResumeJournal, canResumeQuotaJournal, cleanPlanAnalysis, cleanText, hasCredential, journalChanges,
  journalChecks, journalCommand, journalApiUsage, journalContext, journalEngine, journalEntries, journalPendingFollowUp, journalPlan, journalQuota, journalStatus } from "./journal-view";
import type { Connection, RecordedSession, WorkerCommand, WorkerEvent } from "./messages";
import { assertProjectRoot, claimCodeProject, type ProjectRoot } from "./project-root";
import { desktopCodeNotice } from "./desktop-notice";
import { apiCliDirectory, canResumeNativeQuota, matchesNativeContinuation, nativeSessionDirectory, readNativeCheckpoint, readNativeHistory, recordNativeRun, restoredNativeTask, retiredHistoryDirectory,
  saveNativeCheckpoint, stagedNativeDirectory } from "./native-history";
import { matchesHistory } from "./history-scope";
import { nativePatches, openNativeEdits, verifiedContinuationEdits } from "./native-patches";
import type { ClaudeTurnObservation } from "./claude-turn";
import { codeProcessLaunch } from "./code-process-launch";
import { codeMemoryFor } from "./code-memory";

const parent = process.parentPort;
declare const DESKTOP_FIXTURE_ALLOWED: boolean;
type PluginRequest = Extract<WorkerEvent, { type: "code-plugin" }>;
type PluginResponse = Extract<WorkerCommand, { type: "code-plugin-result" }>;
import { readAgentGitSwitch } from "./git-agent-switch";
import type { GitToolAction } from "../../../tomverse-cli/src/git-tools.js";
import type { AgentGitAction, AgentGitResult } from "../git-actions-contract";
type ActiveRun = {
  runId: string;
  cancelled: boolean;
  abort: AbortController;
  runner?: Runner;
  browserSnapshot?: { requestId: string; settle: (text: string | null) => void };
  pluginRequest?: { requestId: string; settle: (result: PluginResponse["result"]) => void };
  gitRequest?: { requestId: string; settle: (result: AgentGitResult | null) => void };
  queueFollowUp?: (text: string, requestId: string) => boolean | Promise<boolean>;
  queueOperation?: (operation: QueueOperation) => boolean;
  /** Sends the task to the window again (a background command printed something or ended). */
  refresh?: () => void;
  approval?: { id: string; canRemember: boolean; settle: (action: Decision["action"]) => void };
};
let active: ActiveRun | undefined;
let recovery: { requestId: string; abort: AbortController } | undefined;
let transient: { journal: Journal; scopeHome: string } | undefined;
const send = (event: WorkerEvent) => parent.postMessage(event);
const supportsCodeApi = (model: CatalogModel) => model.tools && model.protocols.includes("chat_completions");
const projectLocks = process.env.TOMVERSE_DESKTOP_PROJECT_LOCKS;
function lockProject(project: ProjectRoot, attachedProject = project) {
  if (!projectLocks) throw new Error("The Code workspace lock location is unavailable.");
  return claimCodeProject(project, projectLocks, attachedProject);
}
const protectedRoots = (root: string) => projectLocks ? [root, projectLocks] : [root];

function validateReferences(workspace: Workspace, references: readonly WorkspaceReference[], key: string) {
  return references.map((reference) => {
    const current = workspace.reference(reference.path);
    if (current.kind !== reference.kind || current.path !== reference.path || hasCredential(current.path, key)) {
      throw new Error("A selected project reference changed.");
    }
    return current;
  });
}

function nativeReferencePrompt(command: Extract<WorkerCommand, { type: "start-codex-fixture" | "start-claude-fixture" | "start-structured-cli-fixture" }>, task: Task) {
  if (!task.references?.length) return command.prompt;
  const workspace = new Workspace(command.project.path, protectedRoots(command.protectedRoot));
  task.references = validateReferences(workspace, task.references, command.connectionKey);
  return withWorkspaceReferences(command.prompt, task.references);
}

const gatewayFor = (connection: Connection, signal?: AbortSignal, maximumKeyCreditCap?: number) => new Gateway(
  resolveEndpoint({ endpoint: connection.endpoint, allowInsecureLocalhost: true }, {}),
  connection.key,
  (input, init) => fetch(input, { ...init, signal: AbortSignal.any([...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(90_000)]) }),
  "tomverse-desktop",
  maximumKeyCreditCap,
);

function claimNativeHistory(history: { id: string; directory: string } | undefined) {
  if (!history) return undefined;
  if (!same(realpathSync(history.directory), history.directory)) throw new Error("The CLI history folder changed.");
  const lock = join(history.directory, "lock");
  claimLock(lock, history.id);
  return lock;
}

async function verifyRefusedRequest(gateway: Gateway, requestId: string) {
  const receipt = await gateway.requestStatus({ requestId });
  if (receipt.found && (receipt.receipt.requestId !== requestId || receipt.receipt.status !== "released" ||
      receipt.receipt.chargedCredits !== 0)) throw new Error("The API refusal is not settled.");
  return receipt;
}

type NativeCommand = Extract<WorkerCommand, { type: "start-codex-fixture" | "start-claude-fixture" }>;

function readNativeQuotaResume(command: NativeCommand) {
  const { history, afterQuota } = command;
  const previous = history?.previous;
  const provider = command.type === "start-codex-fixture" ? "openai" : "anthropic";
  if (!history || !afterQuota || !previous?.nativeSession || hasCredential(command.prompt, afterQuota.connection.key)) {
    throw new Error("The saved native task cannot be resumed.");
  }
  const saved = readNativeCheckpoint(history.directory, history.id, command.project.path, provider);
  if (!saved || saved.mode !== command.mode || !saved.nativeSession || !canResumeNativeQuota(restoredNativeTask(saved)) ||
      saved.nativeSession.model !== command.fixture.model || saved.nativeSession.threadId !== previous.nativeSession.threadId ||
      saved.nativeSession.turnId !== previous.nativeSession.turnId) throw new Error("The saved native quota pause changed.");
  return { history, saved, afterQuota };
}

function recordNativeQuotaFollowUp(command: NativeCommand, task: Task, entries: Task["entries"]) {
  const { history, saved, afterQuota } = readNativeQuotaResume(command);
  const entry = { role: "user" as const, text: cleanText(command.prompt, afterQuota.connection.key) };
  const conversation = [...task.entries, entry];
  saveNativeCheckpoint(history.directory, { ...task, entries: conversation, nativeSession: undefined }, saved.mode, true, undefined, saved.apiSource);
  task.entries = conversation;
  entries.push(entry);
  send({ type: "follow-up-queued", runId: command.runId, requestId: afterQuota.requestId, queued: true });
}

function finishNativeQuotaFollowUp(task: Task, previous: Task | undefined,
  resume: ReturnType<typeof readNativeQuotaResume> | undefined, submitted: boolean) {
  if (!submitted) {
    if (previous) Object.assign(task, previous);
    return;
  }
  if (!resume) return;
  if (task.nativeSession?.turnId === previous?.nativeSession?.turnId) {
    task.nativeSession = undefined;
    task.status = "unknown";
    task.quota = undefined;
  }
  try {
    const { history, saved } = resume;
    saveNativeCheckpoint(history.directory, task, saved.mode, false, undefined, saved.apiSource);
  } catch {
    task.status = "unknown";
    task.quota = undefined;
  }
}

function checkpointNativeQuotaProgress(task: Task, resume: ReturnType<typeof readNativeQuotaResume>, last: string | undefined) {
  const latest = JSON.stringify([task.nativeSession, task.nativeRuns, task.plan, task.changes]);
  if (!task.nativeSession || latest === last) return last;
  try {
    saveNativeCheckpoint(resume.history.directory, task, resume.saved.mode, true, undefined, resume.saved.apiSource);
    return latest;
  } catch {
    return last;
  }
}

async function executeCodexFixture(command: Extract<WorkerCommand, { type: "start-codex-fixture" }>) {
  if (active) return;
  const prompt = cleanText(command.prompt);
  const previous = command.history?.previous;
  const entries: Task["entries"] = previous
    ? previous.entries.filter(({ role }) => role !== "plan" && role !== "event") : [{ role: "user", text: prompt }];
  const task: Task = {
    id: command.history?.id ?? null, root: command.project.path, title: previous?.title ?? prompt.slice(0, 80), status: "starting",
    entries: previous?.entries ?? entries,
    execution: codexFixtureExecution, readOnly: command.mode !== "agent", savedLocally: !!command.history, changes: [], checks: [], transmission: [],
    nativeSession: previous?.nativeSession, nativeRuns: previous?.nativeRuns,
    plan: previous?.plan && { ...previous.plan, analysis: undefined }, model: previous?.model, effort: previous?.effort ?? "default",
    references: command.apiSource ? undefined : command.references ?? previous?.references,
  };
  if (recovery) {
    task.status = "failed";
    task.entries.push(desktopCodeNotice("recoveryRunning"));
    send({ type: "finished", runId: command.runId, task });
    return;
  }
  const control: ActiveRun = { runId: command.runId, cancelled: false, abort: new AbortController() };
  active = control;
  transient = undefined;
  const previousPlanPosition = previous?.entries.findIndex(({ role }) => role === "plan") ?? -1;
  let planPosition = previousPlanPosition >= 0 ? previousPlanPosition : undefined;
  let unlockProject: (() => void) | undefined;
  let lock: string | undefined;
  let sourceJournal: Journal | undefined;
  let verifySource: ((signal: AbortSignal) => Promise<void>) | undefined;
  let sourceCheckOutcome: "stopped" | "failed" | undefined;
  let quotaResume: ReturnType<typeof readNativeQuotaResume> | undefined;
  let quotaSubmitted = false;
  let quotaProgress: string | undefined;
  let patches: ReturnType<typeof nativePatches> | undefined;
  let quota: Task["quota"];
  try {
    unlockProject = lockProject(command.project);
    lock = claimNativeHistory(command.history);
    quotaResume = command.afterQuota ? readNativeQuotaResume(command) : undefined;
    if (quotaResume && !!quotaResume.saved.apiSource !== !!command.apiSource) throw new Error("The continuation history changed.");
    let inputPrompt = nativeReferencePrompt(command, task);
    if (command.apiSource) {
      const { scope, connection, ...source } = command.apiSource;
      const history = command.history;
      const gateway = gatewayFor(connection, AbortSignal.any([control.abort.signal, AbortSignal.timeout(5_000)]));
      if (!DESKTOP_FIXTURE_ALLOWED || !history || !command.fixture.allowSavedHistory || (command.mode === "agent" && !command.fixture.allowFileEdits) ||
          (!quotaResume && (previous || source.segmentId !== command.runId)) ||
          source.model !== command.fixture.model || source.version !== command.fixture.version ||
          scope.root !== command.project.path || scope.base !== gateway.endpoint.base || sha256(connection.key) !== scope.keyIdentity ||
          !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(gateway.endpoint.origin)) throw new Error("The CLI continuation is unavailable.");
      const directory = apiCliDirectory(scope.home, history.id);
      const saved = readNativeCheckpoint(directory, history.id, command.project.path, "openai");
      if (history.directory !== directory || !saved?.apiSource || saved.mode !== command.mode ||
          (!quotaResume && saved.nativeSession) || JSON.stringify(saved.apiSource) !== JSON.stringify(source)) throw new Error("The CLI checkpoint changed.");
      sourceJournal = openRecordedSession({ scope, project: command.project, sessionId: history.id, storage: scope.home });
      if (!sourceJournal || sourceJournal.state.id !== history.id) throw new Error("The API checkpoint is unavailable.");
      task.effort = sourceJournal.state.tasks.at(-1)?.effort ?? "default";
      const terminal = sourceJournal.state.generations.at(-1);
      if (terminal?.requestId !== source.requestId) throw new Error("The API refusal changed.");
      await sessionCost(gateway, sourceJournal);
      const refusal = await verifyRefusedRequest(gateway, source.requestId);
      control.abort.signal.throwIfAborted();
      assertProjectRoot(command.project);
      terminal.lookup = refusal.found ? "found" : "not_found";
      terminal.receipt = refusal.found ? refusal.receipt : null;
      terminal.lookupAt = new Date().toISOString();
      sourceJournal.commit();
      Object.assign(task, journalApiUsage(sourceJournal.state, connection.key));
      const readOnly = command.mode !== "agent";
      if (sourceJournal.broken || !canContinueApiQuota(sourceJournal.state, source.requestId, readOnly)) {
        throw new Error("The API requests have not been reconciled.");
      }
      const verified = sourceJournal;
      const edits = readOnly ? [] : verifiedContinuationEdits(verified);
      verifySource = async (signal) => {
        try {
          await verifyRefusedRequest(gatewayFor(connection, AbortSignal.any([signal, AbortSignal.timeout(5_000)])), source.requestId);
          signal.throwIfAborted();
          assertProjectRoot(command.project);
          if (!readOnly) verifiedContinuationEdits(verified);
        } catch (error) {
          if (control.cancelled) sourceCheckOutcome = "stopped";
          else if (!signal.aborted) sourceCheckOutcome = "failed";
          throw error;
        }
      };
      const checkpoint = {
        objective: saved.title,
        tasks: journalPlan(sourceJournal.state, connection.key)?.items.map(({ title, complete, cancelled }) => ({
          title: title.slice(0, 96), status: complete ? "verified" : cancelled ? "cancelled" : "pending",
        })) ?? [],
        ...(source.transfer === "summary_and_changes" ? { edits } : { completedEdits: edits.length }),
      };
      const summary = JSON.stringify(checkpoint);
      if (hasCredential(summary, connection.key)) throw new Error("The checkpoint includes a credential.");
      if (!quotaResume) {
        inputPrompt = `Continue the unfinished work from this checkpoint using read-only tools${readOnly
          ? "." : " to inspect the current workspace first. New file edits require fresh Desktop approval."} Preserve verified results.\n\n` + summary;
      }
    }
    if (command.mode === "agent") {
      if (!command.fixture.allowFileEdits || !command.history || (previous && !quotaResume)) throw new Error("This Codex task cannot edit files.");
      patches = nativePatches({
        ...command.history, project: command.project, protectedRoots: protectedRoots(command.protectedRoot), model: command.fixture.model,
        connectionKey: command.connectionKey, signal: control.abort.signal, resume: !!quotaResume,
        approve: (view, signal) => approveNativePatch(view, signal, control, task),
      });
    }
    const { runCodexFixture } = await import("./codex-fixture-run");
    const previousTurn = previous?.nativeSession && { ...previous.nativeSession, status: quotaResume ? "failed" as const : "interrupted" as const };
    const resume = quotaResume;
    const beforeTurn = resume ? async (signal: AbortSignal) => {
      if (verifySource) await verifySource(signal);
      else await gatewayFor(resume.afterQuota.connection, signal).models();
      signal.throwIfAborted();
      assertProjectRoot(command.project);
      if (patches) verifiedContinuationEdits(patches.journal);
      recordNativeQuotaFollowUp(command, task, entries);
      quotaSubmitted = true;
    } : verifySource;
    const result = await runCodexFixture(command.fixture, { project: command.project, prompt: inputPrompt,
      mode: command.mode, clientVersion: command.clientVersion, signal: control.abort.signal, patchTool: patches?.tool,
      protectedRoots: protectedRoots(command.protectedRoot), connectionKey: command.connectionKey,
      effort: task.effort === "low" || task.effort === "high" ? task.effort : undefined,
      verifyDestination: command.apiSource && true, verifySource: beforeTurn,
      history: command.history && { home: join(command.history.directory, "profile"), previous: previousTurn },
    }, (observation) => {
      task.status = control.cancelled ? "stopping" : control.approval ? "approval" : "running";
      task.nativeSession = observation.session;
      recordNativeRun(task, observation.usage);
      quota = observation.usageLimitExceeded ? { source: "codex", reason: "usageLimitExceeded",
        threadId: observation.session.threadId, turnId: observation.session.turnId } : undefined;
      task.model = observation.session.model;
      if (patches) task.changes = journalChanges(patches.journal.state);
      task.entries = [...entries, ...observation.messages.map((message) => ({ ...message, text: cleanText(message.text) }))];
      task.streamingAnswer = observation.streamingAnswer && cleanText(observation.streamingAnswer);
      task.pendingFollowUp = observation.pendingFollowUp && cleanText(observation.pendingFollowUp);
      if (observation.rows.length || previous?.plan) {
        planPosition ??= task.entries.length;
        task.entries.splice(planPosition, 0, { role: "plan" });
        const items: NonNullable<Task["plan"]>["items"] = observation.rows.map((row) => ({
          id: row.id, segmentId: command.apiSource?.segmentId ?? observation.session.threadId,
          title: cleanText(row.title), complete: row.state === "completed", cancelled: row.state === "cancelled",
          completionUnverified: row.state === "unverified", nativeAssignment: row.assignment,
          evidenceStart: row.evidenceStart,
          evidence: row.evidence.map((entry) => ({ tool: entry.tool ?? "run_command", state: entry.result, assignment: entry.model, nativeItemId: entry.id })),
        }));
        const updated = new Map(items.map((row) => [row.id, row]));
        const previousRows = previous?.plan?.items ?? [];
        const known = new Set(previousRows.map(({ id }) => id));
        let room = 24 - items.length;
        const retained = previousRows.flatMap((old) => {
          const row = updated.get(old.id);
          if (!row) return room-- > 0 ? [old] : [];
          const evidenceLimit = 64 - row.evidence.length;
          const older = evidenceLimit > 0 ? old.evidence.slice(-evidenceLimit) : [];
          const unresolved = older.some(({ state }) => state === "unconfirmed");
          return [{ ...row, complete: row.complete && !unresolved, evidenceStart: older.length + (row.evidenceStart ?? 0),
            evidence: [...older, ...row.evidence] }];
        });
        task.plan = {
          activeId: observation.rows.find(({ state }) => state === "running")?.id ?? null,
          analysis: cleanPlanAnalysis(observation.analysis, command.connectionKey),
          items: [...retained, ...items.filter(({ id }) => !known.has(id))],
        };
        if (command.mode === "plan") task.plan = asProposedCodePlan(task.plan);
      }
      if (quotaSubmitted && quotaResume) quotaProgress = checkpointNativeQuotaProgress(task, quotaResume, quotaProgress);
      send({ type: "task", runId: command.runId, task });
    }, (steer) => {
      control.queueFollowUp = (text, requestId) => {
        if (control.cancelled) return false;
        assertProjectRoot(command.project);
        return steer(requestId, text);
      };
    });
    task.status = sourceCheckOutcome ?? result;
  } catch (error) {
    task.status = task.nativeSession ? "unknown" : "failed";
    if (error instanceof SessionLockedError) task.entries.push(desktopCodeNotice("workspaceBusy"));
  } finally {
    if (patches) {
      task.changes = journalChanges(patches.journal.state);
      if (task.status === "blocked") {
        try { verifiedContinuationEdits(patches.journal); }
        catch { task.status = "unknown"; }
      }
      patches.journal.release();
    }
    task.streamingAnswer = undefined;
    task.pendingFollowUp = undefined;
    task.quota = task.status === "blocked" ? quota : undefined;
    recordNativeRun(task);
    if (command.afterQuota) finishNativeQuotaFollowUp(task, previous, quotaResume, quotaSubmitted);
    sourceJournal?.release();
    try { if (lock) unlinkSync(lock); } catch { /* An unavailable lock cannot authorize another run. */ }
    unlockProject?.();
    task.canResume = task.readOnly && task.savedLocally && task.status === "stopped" && !!task.nativeSession;
    task.canResumeAfterQuota = canResumeNativeQuota(task);
    task.canCheckRecovery = task.savedLocally && task.status === "unknown" && !!task.nativeSession;
    if (task.status === "unknown") task.entries.push(desktopCodeNotice("runUnknown"));
    if (task.status === "failed" && !task.nativeSession && !task.entries.some((entry) => entry.role === "event" && entry.notice === "workspaceBusy")) {
      task.entries.push(desktopCodeNotice("runtimeFailed"));
    }
    active = undefined;
    send({ type: "finished", runId: command.runId, task });
  }
}

async function followUp(data: Extract<WorkerCommand, { type: "follow-up" }>) {
  const run = active;
  let queued = false;
  try {
    if (run?.runId === data.runId) queued = await run.queueFollowUp?.(data.text, data.requestId) === true;
  } catch { /* A changed root or unwritable checkpoint cannot accept the instruction. */ }
  send({ type: "follow-up-queued", runId: data.runId, requestId: data.requestId, queued });
}

async function executeStructuredFixture(command: Extract<WorkerCommand, { type: "start-claude-fixture" | "start-structured-cli-fixture" }>) {
  if (active) return;
  const cliTask = command.type === "start-structured-cli-fixture";
  const execution = cliTask ? (command.provider === "google" ? antigravityFixtureExecution : command.provider === "xai" ? grokFixtureExecution : command.provider === "minimax" ? miniMaxFixtureExecution : command.provider === "zhipu" ? zCodeFixtureExecution : command.provider === "deepseek" ? deepSeekFixtureExecution : command.provider === "mistral" ? vibeFixtureExecution : command.provider === "moonshot" ? kimiFixtureExecution : qwenFixtureExecution) : claudeFixtureExecution;
  const prompt = cleanText(command.prompt);
  const previous = command.history?.previous;
  const entries: Task["entries"] = previous
    ? previous.entries.filter(({ role }) => role !== "plan" && role !== "event")
    : [{ role: "user", text: prompt }];
  const task: Task = {
    id: command.history?.id ?? null, root: command.project.path, title: previous?.title ?? prompt.slice(0, 80), status: "starting",
    entries: previous?.entries ?? entries, plan: previous?.plan && { ...previous.plan, analysis: undefined },
    model: previous?.model, nativeSession: previous?.nativeSession,
    effort: previous?.effort ?? "default", nativeRuns: previous?.nativeRuns,
    references: command.references ?? previous?.references,
    execution, readOnly: command.mode !== "agent", savedLocally: !!command.history, changes: [], checks: [], transmission: [],
  };
  if (recovery) {
    task.status = "failed";
    task.entries.push(desktopCodeNotice("recoveryRunning"));
    send({ type: "finished", runId: command.runId, task });
    return;
  }
  const control: ActiveRun = { runId: command.runId, cancelled: false, abort: new AbortController() };
  active = control;
  transient = undefined;
  const previousPlanPosition = previous?.entries.findIndex(({ role }) => role === "plan") ?? -1;
  let planPosition = previousPlanPosition >= 0 ? previousPlanPosition : undefined;
  let unlockProject: (() => void) | undefined;
  let lock: string | undefined;
  let quotaResume: ReturnType<typeof readNativeQuotaResume> | undefined;
  let quotaSubmitted = false;
  let quotaProgress: string | undefined;
  let patches: ReturnType<typeof nativePatches> | undefined;
  try {
    unlockProject = lockProject(command.project);
    lock = claimNativeHistory(command.history);
    const inputPrompt = nativeReferencePrompt(command, task);
    quotaResume = !cliTask && command.afterQuota ? readNativeQuotaResume(command) : undefined;
    const resume = quotaResume;
    if (command.mode === "agent") {
      if (!command.fixture.allowFileEdits || !command.history || (previous && !resume && previous.status !== "stopped")) {
        throw new Error("This CLI task cannot edit files.");
      }
      patches = nativePatches({
        ...command.history, project: command.project, protectedRoots: protectedRoots(command.protectedRoot), model: command.fixture.model,
        connectionKey: command.connectionKey, signal: control.abort.signal, resume: !!previous,
        approve: (view, signal) => approveNativePatch(view, signal, control, task),
      });
    }
    const publish = (observation: Omit<ClaudeTurnObservation, "status" | "usage"> & { usage?: CodeNativeUsage }) => {
      task.status = control.cancelled ? "stopping" : control.approval ? "approval" : "running";
      task.nativeSession = observation.session;
      recordNativeRun(task, observation.usage);
      task.model = observation.session.model;
      if (patches) task.changes = journalChanges(patches.journal.state);
      task.entries = [...entries, ...observation.messages.map((message) => ({ ...message, text: cleanText(message.text) }))];
      task.streamingAnswer = observation.streamingAnswer && cleanText(observation.streamingAnswer);
      task.pendingFollowUp = observation.pendingFollowUp && cleanText(observation.pendingFollowUp);
      if (observation.plan) {
        task.plan = {
          ...observation.plan,
          analysis: cleanPlanAnalysis(observation.plan.analysis, command.connectionKey),
          items: observation.plan.items.map((row) => ({
            ...row, segmentId: observation.session.threadId, title: cleanText(row.title),
          })),
        };
        planPosition ??= task.entries.length;
        task.entries.splice(planPosition, 0, { role: "plan" });
      }
      if (quotaSubmitted && quotaResume) quotaProgress = checkpointNativeQuotaProgress(task, quotaResume, quotaProgress);
      send({ type: "task", runId: command.runId, task });
    };
    const prior = previous?.nativeSession && { session: previous.nativeSession, plan: previous.plan };
    const profile = command.history && join(command.history.directory, cliTask && command.provider === "minimax" ? "m" : "profile");
    const input = { project: command.project, prompt: inputPrompt, mode: command.mode,
      signal: control.abort.signal, patchTool: patches?.tool };
    const beforeStart = previous ? async (signal: AbortSignal) => {
      if (resume) await gatewayFor(resume.afterQuota.connection, signal).models();
      signal.throwIfAborted();
      assertProjectRoot(command.project);
      if (patches) verifiedContinuationEdits(patches.journal);
      if (resume && !cliTask) {
        recordNativeQuotaFollowUp(command, task, entries);
        quotaSubmitted = true;
      }
    } : undefined;
    const result = cliTask
      ? await import("./structured-cli-fixture-run").then(({ runStructuredCliFixture }) => runStructuredCliFixture(command.fixture, {
        ...input, retainedProfile: profile, previous: prior, beforeStart, clientVersion: command.clientVersion,
        deepSeekStartupParent: projectLocks && dirname(projectLocks),
        protectedRoots: protectedRoots(command.protectedRoot), connectionKey: command.connectionKey, provider: command.provider,
        beforeFollowUp: () => {
          if (patches) verifiedContinuationEdits(patches.journal);
        },
      }, ({ status, session, plan, answer, messages, pendingFollowUp, usage }) => publish({
        session, plan, usage,
        messages, pendingFollowUp, streamingAnswer: status ? undefined : answer,
      }), (queue) => {
        control.queueFollowUp = (text) => {
          if (control.cancelled || control.approval) return false;
          assertProjectRoot(command.project);
          return queue(text);
        };
      }))
      : await import("./claude-fixture-run").then(({ runClaudeFixture }) => runClaudeFixture(command.fixture, {
        ...input, beforeStart, history: profile ? { home: profile, previous: prior } : undefined,
      }, publish, (steer) => {
        control.queueFollowUp = (text, requestId) => {
          if (control.cancelled) return false;
          assertProjectRoot(command.project);
          return steer(requestId, text);
        };
      }));
    task.status = result.status;
    if (result.status === "blocked") task.quota = result.quota;
  } catch (error) {
    task.status = task.nativeSession ? "unknown" : "failed";
    if (error instanceof SessionLockedError) task.entries.push(desktopCodeNotice("workspaceBusy"));
  } finally {
    if (patches) {
      task.changes = journalChanges(patches.journal.state);
      if (task.status === "blocked" || task.status === "stopped") {
        try { verifiedContinuationEdits(patches.journal); }
        catch { task.status = "unknown"; task.quota = undefined; }
      }
      patches.journal.release();
    }
    task.streamingAnswer = undefined;
    task.pendingFollowUp = undefined;
    recordNativeRun(task);
    if (!cliTask && command.afterQuota) finishNativeQuotaFollowUp(task, previous, quotaResume, quotaSubmitted);
    try { if (lock) unlinkSync(lock); } catch { /* An unavailable lock cannot authorize another run. */ }
    unlockProject?.();
    task.canResume = task.savedLocally && task.status === "stopped" && !!task.nativeSession;
    task.canResumeAfterQuota = canResumeNativeQuota(task);
    task.canCheckRecovery = !cliTask && task.savedLocally && task.status === "unknown" && !!task.nativeSession;
    if (task.status === "unknown") task.entries.push(desktopCodeNotice("runUnknown"));
    if (task.status === "failed" && !task.entries.some((entry) => entry.role === "event" && entry.notice === "workspaceBusy")) {
      task.entries.push(desktopCodeNotice("runtimeFailed"));
    }
    active = undefined;
    send({ type: "finished", runId: command.runId, task });
  }
}

async function approveNativePatch(view: ApprovalView, signal: AbortSignal, control: ActiveRun, task: Task) {
  signal.throwIfAborted();
  const request = { ...describeApproval(view, new ApprovalMemory()), canRemember: false };
  task.status = "approval";
  if (task.nativeSession) task.pendingNativeApproval = { callId: view.toolCallId, turnId: task.nativeSession.turnId };
  send({ type: "task", runId: control.runId, task });
  const action = await new Promise<Decision["action"]>((resolve) => {
    const cancel = () => settle("deny");
    const settle = (choice: Decision["action"]) => {
      signal.removeEventListener("abort", cancel);
      resolve(choice);
    };
    control.approval = { id: request.id, canRemember: false, settle };
    signal.addEventListener("abort", cancel, { once: true });
    send({ type: "approval", runId: control.runId, request });
  });
  control.approval = undefined;
  task.pendingNativeApproval = undefined;
  return action === "once" && !signal.aborted;
}

/** The commands the task keeps running in the background, for the Code screen: what they are, whether they run, and their newest output. */
function backgroundView(runner: Runner | undefined, clean: (text: string) => string): Task["background"] {
  const list = runner?.background.list() ?? [];
  if (!runner || !list.length) return undefined;
  return list.slice(-8).map((info) => ({
    handle: info.handle, command: clean(info.display).slice(0, 300), state: info.state, startedAt: info.startedAt,
    ...(info.state !== "running" ? { exitCode: info.exitCode ?? null } : {}),
    output: clean(runner.background.peek(info.handle, 4096)),
  }));
}

function describeApproval(view: ApprovalView, memory: ApprovalMemory): ApprovalRequest {
  const clean = (text: string) => cleanText(text);
  const command = view.command;
  return {
    id: randomUUID(),
    root: clean(view.root ?? ""),
    tool: view.toolName,
    explanation: view.explanation && clean(view.explanation),
    canRemember: memory.canRemember(view),
    ...(view.web ? { web: { url: clean(view.web.url), host: clean(view.web.host) } } : {}),
    command: command && {
      mode: command.mode, file: clean(command.file), args: command.args.map(clean), cwd: clean(command.cwd),
      display: clean(command.display), env: command.envNames.map(clean), timeoutMs: command.timeoutMs,
      ...(command.background ? { background: true } : {}),
    },
    files: view.patch?.map((edit) => ({
      path: clean(edit.path), action: edit.action, eol: edit.eol, bom: edit.bom, preimage: edit.preimage,
      postimage: edit.postimage, before: edit.beforeText === null ? null : clean(edit.beforeText),
      after: edit.afterText === null ? null : clean(edit.afterText),
    })),
  };
}

function requestBrowserSnapshot(control: ActiveRun, signal: AbortSignal) {
  return new Promise<string | null>((resolve) => {
    const stop = AbortSignal.any([signal, control.abort.signal, AbortSignal.timeout(6_000)]);
    if (control.browserSnapshot || stop.aborted) { resolve(null); return; }
    const requestId = randomUUID();
    const settle = (text: string | null) => {
      stop.removeEventListener("abort", aborted);
      control.browserSnapshot = undefined;
      resolve(text?.slice(0, 6_000) ?? null);
    };
    const aborted = () => settle(null);
    stop.addEventListener("abort", aborted, { once: true });
    control.browserSnapshot = { requestId, settle };
    send({ type: "browser-snapshot", runId: control.runId, requestId });
  });
}

/** Asks the main process to commit or push. It opens an approval card the agent cannot answer; no time limit, since a person answers it. */
function requestGitAction(control: ActiveRun, action: GitToolAction, signal: AbortSignal) {
  return new Promise<AgentGitResult | null>((resolve) => {
    const stop = AbortSignal.any([signal, control.abort.signal]);
    if (control.gitRequest || stop.aborted) { resolve(null); return; }
    const requestId = randomUUID();
    const settle = (result: AgentGitResult | null) => {
      stop.removeEventListener("abort", aborted);
      control.gitRequest = undefined;
      resolve(result);
    };
    const aborted = () => settle(null);
    stop.addEventListener("abort", aborted, { once: true });
    control.gitRequest = { requestId, settle };
    send({ type: "git-action", runId: control.runId, requestId, action: action as AgentGitAction });
  });
}

function requestCodePlugin(control: ActiveRun, action: PluginRequest["action"], signal: AbortSignal) {
  return new Promise<PluginResponse["result"]>((resolve) => {
    const stop = AbortSignal.any([signal, control.abort.signal, AbortSignal.timeout(16_000)]);
    if (control.pluginRequest || stop.aborted) { resolve(null); return; }
    const requestId = randomUUID();
    const settle = (result: PluginResponse["result"]) => {
      stop.removeEventListener("abort", aborted);
      control.pluginRequest = undefined;
      resolve(result);
    };
    const aborted = () => {
      send({ type: "code-plugin-cancel", runId: control.runId, requestId });
      settle(null);
    };
    stop.addEventListener("abort", aborted, { once: true });
    control.pluginRequest = { requestId, settle };
    send({ type: "code-plugin", runId: control.runId, requestId, action });
  });
}

async function execute(command: Extract<WorkerCommand, { type: "start" | "resume" }>) {
  if (active) return;
  const resuming = command.type === "resume";
  const usesCodePlugin = command.type === "start" && Boolean(command.input.pluginConnectionId);
  const continuation = command.type === "start" ? command.continuation : undefined;
  const afterQuota = resuming ? command.afterQuota : undefined;
  const afterClarification = resuming ? command.afterClarification : undefined;
  const resumedInstruction = afterQuota ?? afterClarification;
  const clean = (text: string) => cleanText(text, command.connection.key);
  const task: Task = resuming ? { ...command.previous, entries: [...command.previous.entries] } : {
    id: null, root: command.project.path, title: clean(command.input.prompt.slice(0, 80)), status: "starting",
    entries: [{ role: "user", text: clean(command.input.prompt) }], effort: command.input.effort, changes: [], checks: [], transmission: [],
    readOnly: command.input.mode !== "agent", savedLocally: !usesCodePlugin && command.input.saveHistory !== false,
  };
  if (recovery) {
    if (!resuming) task.status = "failed";
    task.entries.push(desktopCodeNotice("recoveryRunning"));
    send({ type: "finished", runId: command.runId, task });
    return;
  }
  const control: ActiveRun = { runId: command.runId, cancelled: false, abort: new AbortController() };
  active = control;
  if (!resuming) transient = undefined;
  const publish = () => {
    if (journal) Object.assign(task, journalEngine(journal.state, command.connection.key));
    task.background = backgroundView(control.runner, clean);
    send({ type: "task", runId: command.runId, task });
  };
  let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
  control.refresh = () => {
    if (backgroundTimer || active !== control) return;
    backgroundTimer = setTimeout(() => {
      backgroundTimer = undefined;
      if (active === control) publish();
    }, 400);
  };
  const addEvent = (event: string | ReturnType<typeof desktopCodeNotice>) => {
    const entry = typeof event === "string" ? { role: "event" as const, text: event } : event;
    task.entries.push({ ...entry, text: clean(entry.text).slice(0, 1_200) });
    if (task.entries.length > 96) task.entries.splice(1, 1);
  };
  let journal: ReturnType<typeof createSession> | undefined;
  let recorded: Journal | undefined;
  let unlockProject: (() => void) | undefined;
  let sourceLock: string | undefined;
  let sourceEdits: Journal | undefined;
  let continuationPrompt: string | undefined;
  let resumedInstructionSaved = false;
  let catalog: CatalogModel[] | undefined;
  let partial = "";
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  let outputPreview = "";
  const updateStream = () => {
    clearTimeout(streamTimer);
    streamTimer = undefined;
    if (outputPreview && !control.cancelled) addEvent(outputPreview);
    outputPreview = "";
    publish();
  };
  const assertAllowed = () => {
    if (control.cancelled) throw new Error("Task stopped.");
    assertProjectRoot(command.project);
  };
  try {
    assertAllowed();
    if (usesCodePlugin && command.type === "start" && (command.input.mode !== "ask" || command.input.saveHistory !== false)) {
      throw new Error("Code plugins require an Ask task without local history.");
    }
    unlockProject = lockProject(command.project);
    if (resuming) {
      if ((command.storage !== null && command.storage !== command.scope.home) ||
          sha256(command.connection.key) !== command.scope.keyIdentity) throw new Error("The saved task cannot be resumed.");
      recorded = openRecordedSession(command);
      if (!recorded || recorded.broken || recorded.state.id !== command.sessionId) throw new Error("The saved task cannot be resumed.");
      if (afterQuota) {
        const quota = journalQuota(recorded.state);
        const savedContinuation = recorded.state.codeContinuation;
        if (!recorded.persisted || !canResumeQuotaJournal(recorded.state) || quota?.source !== "tomverse_api" ||
            quota.requestId !== afterQuota.refusedRequestId || hasCredential(afterQuota.text, command.connection.key) ||
            savedContinuation?.segmentId !== afterQuota.continuation?.segmentId ||
            savedContinuation?.maximumKeyCreditCap !== afterQuota.continuation?.maximumKeyCreditCap) {
          throw new Error("The saved quota pause cannot be resumed.");
        }
      } else if (afterClarification) {
        if (!canAnswerClarification(recorded.state) || hasCredential(afterClarification.text, command.connection.key)) {
          throw new Error("The saved clarification cannot be answered.");
        }
      } else if (!canResumeJournal(recorded.state)) throw new Error("The saved task cannot be resumed.");
    }
    const savedCap = recorded?.state.codeContinuation?.maximumKeyCreditCap;
    const gateway = gatewayFor(command.connection, control.abort.signal, continuation?.maximumKeyCreditCap ?? savedCap);
    if (resuming && gateway.endpoint.base !== command.scope.base) throw new Error("The saved task cannot be resumed.");
    if (continuation && command.type === "start") {
      if (!DESKTOP_FIXTURE_ALLOWED || gateway.endpoint.base !== command.scope.base ||
          !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(gateway.endpoint.origin) ||
          !command.input.saveHistory || command.references.length > 0 ||
          command.input.model !== continuation.model || sha256(command.connection.key) !== command.scope.keyIdentity) {
        throw new Error("The continuation route is unavailable.");
      }
      const { sourceHome, sourceProvider, taskId, ...expected } = continuation;
      const directory = nativeSessionDirectory(sourceHome, taskId);
      sourceLock = claimNativeHistory({ id: taskId, directory });
      const source = readNativeHistory(sourceHome, taskId, command.project.path, sourceProvider);
      if (!source?.continuation || source.mode !== command.input.mode ||
          JSON.stringify(source.continuation) !== JSON.stringify(expected)) {
        throw new Error("The saved continuation could not be verified.");
      }
      if (source.mode === "agent") sourceEdits = openNativeEdits(directory, taskId, command.project);
      const edits = sourceEdits ? verifiedContinuationEdits(sourceEdits) : [];
      const checkpoint = {
        objective: source.title,
        tasks: source.plan?.items.map(({ title, complete, cancelled }) => ({
          title: title.slice(0, 96), status: complete ? "verified" : cancelled ? "cancelled" : "pending",
        })) ?? [],
        ...(expected.transfer === "summary_and_changes" ? { edits } : { completedEdits: edits.length }),
      };
      const data = JSON.stringify(checkpoint);
      if (hasCredential(data, command.connection.key)) throw new Error("The continuation includes a credential.");
      continuationPrompt = `Continue the remaining parts of this Code task. ${source.mode === "agent"
        ? "Inspect the current workspace before proposing any additional change. New modifications require fresh user approval."
        : "Use read-only tools and check the current workspace as needed."} Preserve verified results and avoid repeating finished changes.\n\n` + data;
      await gateway.verifyCappedContinuation(control.abort.signal);
      assertAllowed();
    }
    if (afterQuota) {
      const signal = AbortSignal.any([control.abort.signal, AbortSignal.timeout(8_000)]);
      await verifyRefusedRequest(gatewayFor(command.connection, signal), afterQuota.refusedRequestId);
      assertAllowed();
    }
    catalog = await gateway.models();
    assertAllowed();
    if (sourceEdits) verifiedContinuationEdits(sourceEdits);
    const checkpoint = recorded?.state;
    const codePermission = resuming ? checkpoint?.codePermission
      : command.input.permissionProfile === "accept_edits" ? "desktop-accept-edits-v1" : undefined;
    if (codePermission && (codePermission !== "desktop-accept-edits-v1" || !DESKTOP_FIXTURE_ALLOWED || continuation ||
        !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(gateway.endpoint.origin) ||
        (resuming ? checkpoint?.codeMode : command.input.mode) !== "agent")) {
      throw new Error("The saved permission profile is unavailable.");
    }
    const modelId = resuming ? checkpoint?.model.pinned ?? checkpoint?.model.requested : command.input.model;
    const model = catalog.find((item) => item.id === modelId && supportsCodeApi(item));
    if (!model) throw new Error("The selected model is unavailable.");
    const execution = resuming ? tomverseApiExecution : codeRouteFor(command.preference, model);
    if (execution.executionMode !== "tomverse_api") throw new Error("The selected Code execution route is unavailable.");
    if (!continuation) task.execution = execution;
    const workspace = new Workspace(command.project.path, protectedRoots(command.protectedRoot));
    const savedReferences = resuming ? checkpoint?.tasks.at(-1)?.references ?? [] : command.references;
    const references = validateReferences(workspace, savedReferences, command.connection.key);
    task.references = references;
    if (resuming) {
      if (!recorded) throw new Error("The saved task cannot be resumed.");
      validateSession(recorded, gateway.endpoint, gateway.keyPrefix);
      if (afterQuota && recorded.state.codeContinuation) {
        const signal = AbortSignal.any([control.abort.signal, AbortSignal.timeout(8_000)]);
        if (!DESKTOP_FIXTURE_ALLOWED || !Number.isSafeInteger(savedCap) || !savedCap || savedCap <= 0 ||
            !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(gateway.endpoint.origin)) {
          throw new Error("The capped continuation route is unavailable.");
        }
        await gateway.verifyCappedContinuation(signal);
        assertAllowed();
      }
      journal = recorded;
    } else {
      const storage = task.savedLocally ? command.scope.home : null;
      if (storage) mkdirSync(storage, { mode: 0o700, recursive: true });
      journal = createSession(storage, {
        root: workspace.root, endpoint: gateway.endpoint, keyPrefix: gateway.keyPrefix, keyIdentity: sha256(command.connection.key), model,
        readOnly: command.input.mode !== "agent",
        codeMode: command.input.mode,
        codePermission,
        limits: resolveLimits(command.input.limits),
        ...(command.input.goal && command.input.mode === "agent" ? { goal: { maxContinuations: GOAL_MAX_CONTINUATIONS } } : {}),
        ...(continuation && { sessionId: continuation.taskId, codeContinuation: {
          segmentId: continuation.segmentId, maximumKeyCreditCap: continuation.maximumKeyCreditCap,
        } }),
      });
    }
    task.execution = execution;
    task.id = journal.state.id;
    task.model = model.name;
    task.status = "running";
    task.quota = undefined;
    task.canResume = false;
    task.canResumeAfterQuota = false;
    task.canAnswerClarification = false;
    task.canRewind = undefined;
    task.pendingFollowUp = journalPendingFollowUp(journal.state, command.connection.key);
    assertAllowed();
    const instructions = continuation || savedCap !== undefined ? null : readProjectInstructions(workspace);
    if (instructions?.truncated) addEvent(desktopCodeNotice("instructionClipped"));
    publish();
    const memory = new ApprovalMemory();
    const output: Output = {
      json: false,
      info: (text) => { addEvent(text); publish(); },
      stream: (text) => {
        const last = task.entries.at(-1);
        if (text === "\n" && last?.role !== "assistant") return;
        if (!partial || last?.role !== "assistant") {
          if (partial && last?.role !== "assistant") partial = "";
          task.entries.push({ role: "assistant", text: "" });
          if (task.entries.length > 96) task.entries.splice(1, 1);
        }
        partial = (partial + text).slice(0, 24_000);
        const response = task.entries.at(-1);
        if (response?.role === "assistant") response.text = clean(partial);
        streamTimer ??= setTimeout(updateStream, 48);
      },
      event: (event) => {
        if (event.type === "follow_up_included" && typeof event.text === "string") {
          task.pendingFollowUp = undefined;
          task.entries.push({ role: "user", text: clean(event.text) });
          if (task.entries.length > 96) task.entries.splice(1, 1);
          publish();
        }
        if (event.type === "command_output") {
          if (!control.cancelled && typeof event.text === "string") {
            outputPreview = `${event.stream === "stderr" ? "stderr" : "stdout"} · ${event.text.slice(-320).trimEnd()}`;
            streamTimer ??= setTimeout(updateStream, 125);
          }
          return;
        }
        if ((event.type === "goal_check" || event.type === "queued_follow_up_started" || event.type === "subagent_started" || event.type === "subagent_finished") && journal) publish();
        if (event.type === "response" && journal) {
          Object.assign(task, journalApiUsage(journal.state, command.connection.key));
          task.context = journalContext(journal.state);
          task.actual = task.transmission.findLast((record) => record.purpose === "agent")?.appliedEffort;
          publish();
        }
        if (event.type === "task_plan" && journal) {
          const previousPlan = task.plan;
          task.plan = journalPlan(journal.state, command.connection.key);
          if (previousPlan && !previousPlan.items.length && task.plan?.items.length) {
            task.entries = task.entries.filter((entry) => entry.role !== "plan");
          }
          if (task.plan && !task.entries.some((entry) => entry.role === "plan")) task.entries.push({ role: "plan" });
          publish();
        }
        if (event.type === "tool_result" && typeof event.tool === "string" && event.tool !== "update_task_plan") {
          const state = journal?.state;
          addEvent(`${event.tool} · ${typeof event.status === "string" ? event.status : "returned"}`);
          if (state) {
            task.changes = journalChanges(state);
            task.checks = journalChecks(state);
          }
          publish();
        }
      },
    };
    const mode = journal.state.codeMode ?? (journal.state.readOnly ? journal.state.tasks.at(-1)?.plan ? "plan" : "ask" : "agent");
    control.runner = new Runner({
      gateway, journal, workspace, catalog, output, productName: "Tomverse Code", commandEnv: [], launchCommand: codeProcessLaunch,
      instructions: instructions?.text ?? null, instructionsTruncated: instructions?.truncated,
      assertAllowed, redactText: clean, captureTransmission: true, echoCommandOutput: false,
      onBackgroundActivity: () => control.refresh?.(),
      web: {},
      backgroundCommands: true,
      images: true,
      subagents: true,
      // A private task (no saved history) and a capped continuation keep and read no notes; so does a person who turned memory off.
      nestedInstructions: !continuation && savedCap === undefined,
      memory: !continuation && savedCap === undefined && task.savedLocally && !usesCodePlugin
        ? codeMemoryFor(process.env.TOMVERSE_DESKTOP_CODE_MEMORY, command.project, clean) : undefined,
      taskPlan: mode === "ask" ? undefined : mode,
      codePlugin: usesCodePlugin ? (action, signal) => requestCodePlugin(control, action, signal) : undefined,
      git: !usesCodePlugin && readAgentGitSwitch(process.env.TOMVERSE_DESKTOP_GIT_AGENT_SWITCH) ? (action, signal) => requestGitAction(control, action, signal) : undefined,
      browserSnapshot: DESKTOP_FIXTURE_ALLOWED && command.type === "start" && command.browserSnapshot &&
        /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(gateway.endpoint.origin)
        ? (signal) => requestBrowserSnapshot(control, signal) : undefined,
      prompter: {
        confirm: async () => false,
        approve: async (view) => {
          if (control.cancelled) return false;
          assertAllowed();
          const details = [view.root, view.explanation, view.web?.url, view.command?.display, view.command?.file, view.command?.cwd,
            ...(view.command?.args ?? []), ...(view.command?.envNames ?? []),
            ...(view.patch?.flatMap((file) => [file.path, file.beforeText, file.afterText]) ?? []),
          ];
          if (details.some((text) => typeof text === "string" && hasCredential(text, command.connection.key))) {
            addEvent(desktopCodeNotice("actionCredential"));
            publish();
            return { approved: false, reason: "Credential present in the proposed operation." };
          }
          if (codePermission && view.patch?.length && view.patch.every(({ action }) => action === "create" || action === "update")) {
            return { approved: true };
          }
          const remembered = memory.match(view);
          if (remembered) return { approved: true, remembered };
          const request = describeApproval(view, memory);
          task.status = "approval";
          publish();
          const action = await new Promise<Decision["action"]>((settle) => {
            control.approval = { id: request.id, canRemember: request.canRemember, settle };
            send({ type: "approval", runId: command.runId, request });
          });
          control.approval = undefined;
          task.status = control.cancelled ? "stopping" : "running";
          publish();
          if (control.cancelled || action === "deny") return false;
          assertAllowed();
          const remember = action === "run" ? memory.remember(view) : null;
          return { approved: true, ...(remember ? { remember } : {}) };
        },
      },
    });
    const runner = control.runner;
    control.queueFollowUp = (text) => {
      if (control.cancelled || control.approval || hasCredential(text, command.connection.key) || !runner.queueFollowUp(text)) return false;
      task.pendingFollowUp = clean(text);
      publish();
      return true;
    };
    control.queueOperation = (operation) => {
      if (control.cancelled || ("text" in operation && hasCredential(operation.text, command.connection.key))) return false;
      assertProjectRoot(command.project);
      const done = operation.kind === "add" ? runner.enqueue(operation.text) !== null
        : operation.kind === "edit" ? runner.editQueued(operation.itemId, operation.text)
        : operation.kind === "remove" ? runner.removeQueued(operation.itemId)
        : runner.moveQueued(operation.itemId, operation.direction);
      if (done) publish();
      return done;
    };
    if (resuming) {
      await control.runner.loop(resumedInstruction && { text: resumedInstruction.text, confirmed: () => {
        resumedInstructionSaved = true;
        send({ type: "follow-up-queued", runId: command.runId, requestId: resumedInstruction.requestId, queued: true });
      } });
    } else {
      const prompt = continuationPrompt ?? (command.input.mode === "plan"
        ? `Review this request using read-only tools. Return the objective, evidence, assumptions, intended changes, verification and completion criteria as a public plan. Do not make changes.\n\n${command.input.prompt}`
        : command.input.prompt);
      if (sourceEdits) verifiedContinuationEdits(sourceEdits);
      await control.runner.runTask(prompt, command.input.effort, continuation || references.length
        ? { visiblePrompt: command.input.prompt, references } : undefined);
      if (!continuation && command.input.mode === "plan" && !references.length) {
        const first = journal.state.messages.find((message) => message.role === "user");
        if (first && first.content === prompt) first.content = command.input.prompt;
        const record = journal.state.tasks[0];
        if (record) record.prompt = command.input.prompt;
        journal.commit();
      }
    }
    task.status = journal.broken ? "unknown" : journalStatus(journal.state);
    const finalEntries = journalEntries(journal.state, command.connection.key);
    if (!task.entries.some((entry) => entry.role === "assistant")) {
      task.entries.push(...finalEntries.filter((entry) => entry.role === "assistant"));
    }
  } catch (error) {
    task.status = resumedInstruction && !resumedInstructionSaved && !journal?.broken
      ? afterClarification ? "clarification" : "blocked"
      : !journal && (resuming || control.cancelled) ? "stopped" : journal ? "unknown" : "failed";
    addEvent(desktopCodeNotice(error instanceof SessionLockedError ? "workspaceBusy"
      : task.status === "unknown" ? "runUnknown" : control.cancelled ? "runStoppedEarly" : "runtimeFailed"));
  } finally {
    control.queueFollowUp = undefined;
    control.queueOperation = undefined;
    control.refresh = undefined;
    clearTimeout(backgroundTimer);
    clearTimeout(streamTimer);
    // Whatever way the task ended, nothing it started may keep running.
    await control.runner?.stopBackground("task_ended").catch(() => undefined);
    task.background = backgroundView(control.runner, clean);
    if (journal) {
      if (!control.cancelled && (!resumedInstruction || resumedInstructionSaved) && journal.state.generations.length) {
        // Receipt reads may fail or lag while the server settles. Finish with the evidence available.
        const receiptSignal = AbortSignal.any([control.abort.signal, AbortSignal.timeout(3_000)]);
        await sessionCost(gatewayFor(command.connection, receiptSignal), journal, catalog).catch(() => undefined);
      }
      task.changes = journalChanges(journal.state);
      task.checks = journalChecks(journal.state);
      Object.assign(task, journalApiUsage(journal.state, command.connection.key), journalEngine(journal.state, command.connection.key));
      task.context = journalContext(journal.state);
      task.actual = task.transmission.findLast((record) => record.purpose === "agent")?.appliedEffort;
      task.plan = journalPlan(journal.state, command.connection.key);
      task.pendingFollowUp = journalPendingFollowUp(journal.state, command.connection.key);
      if (task.status === "blocked" || task.status === "failed") {
        task.status = journal.broken ? "unknown" : journalStatus(journal.state);
        task.quota = task.status === "blocked" ? journalQuota(journal.state) : undefined;
      }
      task.canCheckRecovery = (!usesCodePlugin && task.status === "unknown") || undefined;
      markTurns(task.entries, journal.state);
      task.canRewind = (!usesCodePlugin && !journal.broken && journal.persisted && canRewindJournal(journal.state)) || undefined;
      task.canResume = (!usesCodePlugin && !journal.broken && canResumeJournal(journal.state)) || undefined;
      task.canResumeAfterQuota = (journal.persisted && !journal.broken && canResumeQuotaJournal(journal.state)) || undefined;
      task.canAnswerClarification = (!usesCodePlugin && !journal.broken && canAnswerClarification(journal.state)) || undefined;
      if (!usesCodePlugin && !journal.persisted) transient = { journal, scopeHome: command.scope.home };
      journal.release();
    }
    if (recorded && recorded !== journal) recorded.release();
    sourceEdits?.release();
    if (sourceLock) {
      try { unlinkSync(sourceLock); } catch { /* The checkpoint retains the confirmed attempt. */ }
    }
    unlockProject?.();
    active = undefined;
    send({ type: "finished", runId: command.runId, task });
  }
}

function openRecordedSession(command: Omit<RecordedSession, "requestId">, attachedProject = command.project): Journal | undefined {
  assertProjectRoot(attachedProject);
  const { scope, sessionId, storage } = command;
  if (storage === null) {
    if (transient?.journal.state.id === sessionId && transient.scopeHome === scope.home &&
        matchesHistory(transient.journal.state, scope, scope.home)) return transient.journal;
    return undefined;
  }
  const journal = Journal.open(storage, sessionId);
  if (matchesHistory(journal.state, scope, storage)) return journal;
  journal.release();
  return undefined;
}

async function checkNativeRecovery(command: Extract<WorkerCommand, { type: "check-native-recovery" }>, signal: AbortSignal): Promise<WorkerEvent> {
  const reply = { type: "recovery-detail", requestId: command.requestId } as const;
  const { directory } = command;
  if (!same(realpathSync(directory), directory) || !command.fixture.allowSavedHistory) return { ...reply, recovery: { status: "unavailable" } };
  const lock = join(directory, "lock");
  claimLock(lock, command.sessionId);
  try {
    const saved = readNativeCheckpoint(directory, command.sessionId, command.project.path, command.provider);
    if (saved?.status !== "unknown" || !saved.nativeSession || saved.nativeSession.model !== command.fixture.model ||
        saved.nativeSession.threadId !== command.session.threadId || saved.nativeSession.turnId !== command.session.turnId ||
        saved.apiSource?.segmentId !== command.segmentId || (saved.apiSource && saved.apiSource.version !== command.fixture.version)) {
      return { ...reply, recovery: { status: "unavailable" } };
    }
    const session = saved.nativeSession;
    const profile = join(directory, "profile");
    const observed = command.provider === "anthropic"
      ? await import("./claude-transcript").then(async ({ inspectClaudeTranscript }) => {
        const commands = await inspectClaudeTranscript({ profile, project: command.project, session, signal,
          version: command.fixture.version, plan: saved.plan });
        return commands && { commands, status: "unconfirmed" as const };
      })
      : await import("./codex-fixture-run").then(({ inspectCodexFixtureHistory }) => inspectCodexFixtureHistory(command.fixture, {
        project: command.project, clientVersion: command.clientVersion, home: profile, signal, session,
      }));
    signal.throwIfAborted();
    assertProjectRoot(command.project);
    const notes: string[] = [];
    let changes: Task["changes"] | undefined;
    if (saved.mode === "agent" && command.fixture.allowFileEdits) {
      const edits = openNativeEdits(directory, saved.id, command.project);
      try {
        notes.push(...reconcile(edits).map((note) => cleanText(note)));
        if (edits.broken) throw edits.broken;
        changes = journalChanges(edits.state);
      } finally {
        edits.release();
      }
    }
    if (!observed && !changes) return { ...reply, recovery: { status: "unavailable" } };

    const { commands, status } = observed ?? { commands: new Map<string, "succeeded" | "failed" | "unconfirmed">(), status: "unconfirmed" };
    let changed = false;
    const rows = saved.plan?.items.map((row) => ({ ...row, evidence: row.evidence.map((entry) => {
      const { nativeItemId, assignment } = entry;
      if (entry.tool === "apply_patch" || !nativeItemId || assignment.threadId !== session.threadId || assignment.turnId !== session.turnId) return entry;
      const state = commands.get(nativeItemId) ?? "unconfirmed";
      if (!commands.has(nativeItemId)) commands.set(nativeItemId, state);
      if (state === "unconfirmed" || entry.state !== "unconfirmed") return entry;
      changed = true;
      return { ...entry, state };
    }) }));
    const native: CodeNativeRecoverySummary = {
      turn: status === "inProgress" ? "running" as const : status === "interrupted" ? "stopped" as const : status,
      passed: 0, failed: 0, unconfirmed: 0,
    };
    for (const outcome of commands.values()) {
      if (outcome === "succeeded") native.passed++;
      else if (outcome === "failed") native.failed++;
      else native.unconfirmed++;
    }
    if (changed || changes) {
      const task = restoredNativeTask(saved);
      signal.throwIfAborted();
      assertProjectRoot(command.project);
      saveNativeCheckpoint(directory, { ...task, changes: changes ?? task.changes,
        plan: changed && rows ? { activeId: null, analysis: task.plan?.analysis, items: rows } : task.plan }, saved.mode, false, saved.continuation, saved.apiSource);
    }
    return { ...reply, recovery: { status: "checked", notes, native } };
  } finally {
    unlinkSync(lock);
  }
}

async function checkRecovery(command: Extract<WorkerCommand, { type: "check-recovery" | "check-native-recovery" }>): Promise<WorkerEvent> {
  const reply = { type: "recovery-detail", requestId: command.requestId } as const;
  if (active || recovery) return { ...reply, recovery: { status: "locked" } };
  const abort = new AbortController();
  recovery = { requestId: command.requestId, abort };
  let journal: Journal | undefined;
  let unlockProject: (() => void) | undefined;
  try {
    unlockProject = lockProject(command.project);
    if (command.type === "check-native-recovery") {
      return DESKTOP_FIXTURE_ALLOWED ? await checkNativeRecovery(command, abort.signal) : { ...reply, recovery: { status: "unavailable" } };
    }
    const key = command.connection.key;
    const endpoint = resolveEndpoint({ endpoint: command.connection.endpoint, allowInsecureLocalhost: true }, {});
    if (endpoint.base !== command.scope.base || sha256(key) !== command.scope.keyIdentity) {
      return { ...reply, recovery: { status: "unavailable" } };
    }
    journal = openRecordedSession(command);
    if (!journal || journalStatus(journal.state) !== "unknown") {
      return { ...reply, recovery: { status: "unavailable" } };
    }
    const notes = reconcile(journal).map((note) => cleanText(note, key));
    if (journal.state.generations.length) {
      const receiptSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(3_000)]);
      await sessionCost(gatewayFor(command.connection, receiptSignal), journal);
      if (journal.broken) throw journal.broken;
    }
    abort.signal.throwIfAborted();
    assertProjectRoot(command.project);
    const { transmission, apiUsage } = journalApiUsage(journal.state, key);
    return { ...reply, recovery: { status: "checked", notes }, evidence: {
      changes: journalChanges(journal.state), checks: journalChecks(journal.state), transmission, apiUsage,
      actual: transmission.findLast((record) => record.purpose === "agent")?.appliedEffort,
    } };
  } catch (error) {
    return { ...reply, recovery: { status: error instanceof SessionLockedError ? "locked" : "unavailable" } };
  } finally {
    journal?.release();
    unlockProject?.();
    recovery = undefined;
  }
}

/** One model request that replaces the earlier part of a saved task's history with a summary. Nothing runs and no file is touched. */
async function compactRecorded(command: Extract<WorkerCommand, { type: "compact-history" }>): Promise<WorkerEvent> {
  const reply = { type: "history-compacted", requestId: command.requestId } as const;
  if (active || recovery) return { ...reply, result: "unavailable" };
  const abort = new AbortController();
  recovery = { requestId: command.requestId, abort };
  let journal: Journal | undefined;
  let unlockProject: (() => void) | undefined;
  try {
    unlockProject = lockProject(command.project);
    const key = command.connection.key;
    const endpoint = resolveEndpoint({ endpoint: command.connection.endpoint, allowInsecureLocalhost: true }, {});
    if (endpoint.base !== command.scope.base || sha256(key) !== command.scope.keyIdentity) return { ...reply, result: "unavailable" };
    journal = openRecordedSession(command);
    if (!journal || journal.broken || journal.state.codeContinuation || journal.state.pendingApprovals.length ||
        journalStatus(journal.state) === "unknown" || !journal.persisted) return { ...reply, result: "unavailable" };
    const gateway = gatewayFor(command.connection, abort.signal);
    validateSession(journal, gateway.endpoint, gateway.keyPrefix);
    const catalog = await gateway.models();
    abort.signal.throwIfAborted();
    assertProjectRoot(command.project);
    const workspace = new Workspace(command.project.path, protectedRoots(command.protectedRoot));
    const mode = journal.state.codeMode ?? (journal.state.readOnly ? "ask" : "agent");
    const runner = new Runner({
      gateway, journal, workspace, catalog, productName: "Tomverse Code", commandEnv: [], instructions: null, prompter: null,
      output: { json: false, info: () => undefined, stream: () => undefined, event: () => undefined },
      assertAllowed: () => assertProjectRoot(command.project), redactText: (text) => cleanText(text, key), captureTransmission: true,
      taskPlan: mode === "ask" ? undefined : mode,
    });
    const outcome = await runner.maybeCompact(true, 180_000);
    if (journal.broken) throw journal.broken;
    await sessionCost(gatewayFor(command.connection, AbortSignal.any([abort.signal, AbortSignal.timeout(3_000)])), journal, catalog).catch(() => undefined);
    return { ...reply, result: outcome === "compacted" ? "compacted" : outcome === "skipped" ? "nothing" : "failed" };
  } catch (error) {
    return { ...reply, result: error instanceof SessionLockedError ? "unavailable" : journal?.broken ? "failed" : "unavailable" };
  } finally {
    journal?.release();
    unlockProject?.();
    recovery = undefined;
  }
}

function readRecorded<T>(command: Extract<WorkerCommand, { type: "read-change" | "read-command" }>, read: (journal: Journal) => T): T | null {
  if (active) return null;
  let journal: Journal | undefined;
  try {
    journal = openRecordedSession(command, command.sourceProject ?? command.project);
    return journal ? read(journal) : null;
  } catch {
    return null;
  } finally {
    journal?.release();
  }
}

function readRecordedChange(journal: Journal, id: string, { undoAvailable = true, checkoutAvailable = true } = {}): ChangeInspection | null {
  const change = journal.state.changes.find((item) => item.changeId === id);
  if (!change) return null;
  const current = checkoutAvailable ? viewChange(journal, change).current : "outside";
  let text: string | null = null;
  if ((change.state === "applied" || change.state === "undone") &&
      (checkoutAvailable || change.postimage.backup !== undefined || change.postimage.sha256 === null)) {
    try { text = cleanText(renderChange(journal, change)); }
    catch { /* The saved diff may be unavailable on an older record. */ }
  }
  return { current, text, canUndo: checkoutAvailable && undoAvailable && journalStatus(journal.state) !== "unknown" && canUndoChange(journal, change) };
}

function undoRecordedChange(command: Extract<WorkerCommand, { type: "undo-change" }>): WorkerEvent {
  const reply = { type: "change-undone", requestId: command.requestId } as const;
  if (active || recovery) return { ...reply, result: "unavailable" };
  let journal: Journal | undefined;
  let unlockProject: (() => void) | undefined;
  let undoStarted = false;
  try {
    unlockProject = lockProject(command.project);
    journal = openRecordedSession(command);
    if (!journal || journalStatus(journal.state) === "unknown") {
      return { ...reply, result: "unavailable" };
    }
    assertProjectRoot(command.project);
    undoStarted = true;
    undoChange(journal, command.recordId, () => assertProjectRoot(command.project), true);
    return { ...reply, result: "undone", changes: journalChanges(journal.state) };
  } catch (error) {
    if (!undoStarted) return { ...reply, result: "unavailable" };
    return { ...reply, result: error instanceof UndoError ? "conflict" : "unconfirmed" };
  } finally {
    journal?.release();
    unlockProject?.();
  }
}

/** What a rewind to a turn would do, for the confirmation the person sees before anything is changed. */
function planRecordedRewind(command: Extract<WorkerCommand, { type: "plan-rewind" }>): WorkerEvent {
  const reply = { type: "rewind-planned", requestId: command.requestId } as const;
  if (active || recovery) return { ...reply, plan: null };
  let journal: Journal | undefined;
  let unlockProject: (() => void) | undefined;
  try {
    unlockProject = lockProject(command.project);
    journal = openRecordedSession(command);
    if (!journal || journalStatus(journal.state) === "unknown") return { ...reply, plan: null };
    assertProjectRoot(command.project);
    const plan = planRewind(journal, command.turn, true);
    return { ...reply, plan: {
      text: cleanText(plan.text), conversationAvailable: plan.conversationAvailable, ...(plan.blocked ? { blocked: true as const } : {}),
      files: plan.files.slice(0, 40).map((file) => ({ path: cleanText(file.path), kind: file.kind, outcome: file.outcome, ...(file.reason ? { reason: cleanText(file.reason) } : {}) })),
      commands: plan.commands.slice(0, 20).map((entry) => cleanText(entry.display)),
    } };
  } catch {
    return { ...reply, plan: null };
  } finally {
    journal?.release();
    unlockProject?.();
  }
}

/** Takes a saved task back to the start of a turn. Files that changed since are reported, never forced. */
function rewindRecorded(command: Extract<WorkerCommand, { type: "rewind-history" }>): WorkerEvent {
  const reply = { type: "history-rewound", requestId: command.requestId, undone: 0, conflicts: 0 } as const;
  if (active || recovery) return { ...reply, result: "unavailable" };
  let journal: Journal | undefined;
  let unlockProject: (() => void) | undefined;
  let started = false;
  try {
    unlockProject = lockProject(command.project);
    journal = openRecordedSession(command);
    if (!journal || journalStatus(journal.state) === "unknown") return { ...reply, result: "unavailable" };
    assertProjectRoot(command.project);
    started = true;
    const outcome = rewindSession(journal, command.turn, command.mode, {
      beforeWrite: () => assertProjectRoot(command.project), requireIdentity: true, redactText: (text) => cleanText(text),
    });
    return { ...reply, result: "rewound", text: cleanText(outcome.text), undone: outcome.undone.length, conflicts: outcome.conflicts.length };
  } catch (error) {
    if (error instanceof RewindError || !started) return { ...reply, result: "unavailable" };
    return { ...reply, result: "unconfirmed" };
  } finally {
    journal?.release();
    unlockProject?.();
  }
}

/** Copies a saved task's conversation through a turn into a new saved task. No file is touched. */
function forkRecorded(command: Extract<WorkerCommand, { type: "fork-history" }>): WorkerEvent {
  const reply = { type: "history-forked", requestId: command.requestId } as const;
  // Only the task's own history store is written to, never a legacy one.
  if (active || recovery || command.storage === null || command.storage !== command.scope.home) return { ...reply, result: "unavailable" };
  let journal: Journal | undefined;
  let unlockProject: (() => void) | undefined;
  try {
    unlockProject = lockProject(command.project);
    journal = openRecordedSession(command);
    if (!journal || journalStatus(journal.state) === "unknown") return { ...reply, result: "unavailable" };
    assertProjectRoot(command.project);
    const forked = forkSession(command.storage, journal, command.turn);
    const id = forked.journal.state.id;
    forked.journal.release();
    return { ...reply, result: "forked", id };
  } catch (error) {
    return { ...reply, result: error instanceof RewindError ? "unavailable" : "unconfirmed" };
  } finally {
    journal?.release();
    unlockProject?.();
  }
}

type DeleteRecordedHistory = Extract<WorkerCommand, { type: "delete-history" }>;

function assertHistoryDirectory(directory: string, identity: string) {
  if (!same(realpathSync(directory), directory) || pathIdentity(directory, "directory") !== identity) {
    throw new Error("The history directory changed.");
  }
}

function releaseHistoryLock(directory: string, identity: string) {
  try {
    assertHistoryDirectory(directory, identity);
    unlinkSync(join(directory, "lock"));
  } catch { /* A committed deletion can have removed the lock and its directory. */ }
}

function removeRetiredHistory(directory: string, identity: string) {
  assertHistoryDirectory(directory, identity);
  rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 100 });
}

function cleanDeletedHistory(profile: string) {
  try {
    const code = join(realpathSync(profile), "code");
    if (!same(realpathSync(code), code)) return;
    for (const scope of readdirSync(code, { withFileTypes: true })) {
      if (!scope.isDirectory() || !/^[0-9a-f]{64}$/.test(scope.name)) continue;
      const sessions = join(code, scope.name, "sessions");
      let entries: Dirent[];
      try {
        if (!same(realpathSync(sessions), sessions)) continue;
        entries = readdirSync(sessions, { withFileTypes: true });
      } catch { continue; }
      for (const entry of entries) {
        const match = /^\.deleted-(.+)\.(\d+)-(\d+)$/.exec(entry.name);
        const id = taskIdSchema.safeParse(match?.[1]);
        if (!entry.isDirectory() || !match || !id.success) continue;
        const directory = join(sessions, entry.name);
        const identity = `${match[2]}:${match[3]}`;
        try {
          assertHistoryDirectory(directory, identity);
          claimLock(join(directory, "lock"), id.data);
          try { removeRetiredHistory(directory, identity); }
          finally { releaseHistoryLock(directory, identity); }
        } catch { /* A live deletion or an inaccessible folder can be checked at the next startup. */ }
      }
    }
  } catch { /* A profile without local Code history has no pending deletions. */ }
}

function hasSplitHistory(code: string, id: string) {
  return readdirSync(code).some((namespace) =>
    /^(codex|claude)-[0-9a-f]{64}$/.test(namespace) && pathIdentity(nativeSessionDirectory(join(code, namespace), id), "directory") !== null);
}

function deletePairedHistory(command: DeleteRecordedHistory, home: string, markVerified: () => void) {
  const { nativeSource: source, sessionId, scope } = command;
  if (!source || command.storage !== scope.home) throw new Error("The continuation source is unavailable.");
  const prefix = source.provider === "openai" ? "codex-" : "claude-";
  const namespace = basename(source.home);
  if (!namespace.startsWith(prefix) || !/^[0-9a-f]{64}$/.test(namespace.slice(prefix.length)) ||
      !same(source.home, join(dirname(scope.home), namespace))) throw new Error("The continuation source is outside its scope.");
  const original = nativeSessionDirectory(join(dirname(home), namespace), sessionId);
  const staged = stagedNativeDirectory(home, sessionId);
  const api = nativeSessionDirectory(home, sessionId);
  let apiPath = api;
  let sourcePath = same(source.directory, staged) ? staged : original;
  if (!same(sourcePath, source.directory)) throw new Error("The continuation source changed.");
  assertHistoryDirectory(apiPath, command.directoryIdentity);
  claimLock(join(apiPath, "lock"), sessionId);
  let sourceLocked = false;
  try {
    assertHistoryDirectory(sourcePath, source.identity);
    claimLock(join(sourcePath, "lock"), sessionId);
    sourceLocked = true;
    assertProjectRoot(command.project);
    assertHistoryDirectory(apiPath, command.directoryIdentity);
    assertHistoryDirectory(sourcePath, source.identity);
    const otherSourcePath = sourcePath === staged ? original : staged;
    if (pathIdentity(otherSourcePath, "directory")) throw new Error("The continuation has more than one source directory.");
    const saved = Journal.read(apiPath);
    const native = readNativeCheckpoint(sourcePath, sessionId, scope.root, source.provider);
    if (saved.id !== sessionId || !matchesHistory(saved, scope, command.storage) || !matchesNativeContinuation(native, saved)) {
      throw new Error("The two checkpoints no longer describe the same continuation.");
    }
    markVerified();

    // If interrupted here, the source remains readable from inside the API record.
    if (sourcePath === original) {
      renameSync(original, staged);
      sourcePath = staged;
    }
    assertProjectRoot(command.project);
    assertHistoryDirectory(apiPath, command.directoryIdentity);
    assertHistoryDirectory(sourcePath, source.identity);
    const removed = retiredHistoryDirectory(apiPath, command.directoryIdentity);
    if (pathIdentity(removed, "directory")) throw new Error("A deletion is already pending.");
    // One rename removes both histories from their live namespace.
    renameSync(apiPath, removed);
    apiPath = removed;
    sourcePath = join(removed, basename(staged));
    removeRetiredHistory(apiPath, command.directoryIdentity);
  } finally {
    if (sourceLocked) releaseHistoryLock(sourcePath, source.identity);
    releaseHistoryLock(apiPath, command.directoryIdentity);
  }
}

function deleteRecordedHistory(command: DeleteRecordedHistory): WorkerEvent {
  const reply = { type: "history-deleted", requestId: command.requestId } as const;
  if (active || recovery) return { ...reply, result: "unavailable" };
  let verified = false;
  let unlockProject: (() => void) | undefined;
  try {
    const attachedProject = command.sourceProject ?? command.project;
    assertProjectRoot(attachedProject);
    const { storage, scope, sessionId, protectedRoot } = command;
    const namespace = basename(storage);
    if ((storage !== scope.home && storage !== scope.legacyHome) || !/^[0-9a-f]{64}$/.test(namespace) ||
        !same(storage, join(protectedRoot, "code", namespace))) return { ...reply, result: "unavailable" };
    const home = join(realpathSync(protectedRoot), "code", namespace);
    const expectedDirectory = join(home, "sessions", sessionId);
    if (!same(realpathSync(expectedDirectory), expectedDirectory)) return { ...reply, result: "unavailable" };

    unlockProject = lockProject(command.project, attachedProject);
    if (DESKTOP_FIXTURE_ALLOWED && command.nativeSource) {
      deletePairedHistory(command, home, () => { verified = true; });
      return { ...reply, result: "deleted" };
    }
    deleteSession(home, sessionId, (directory) => {
      if (!same(directory, expectedDirectory) || pathIdentity(directory, "directory") !== command.directoryIdentity) return false;
      assertProjectRoot(attachedProject);
      let saved: Journal["state"] | undefined;
      try { saved = Journal.read(directory); } catch { /* The scoped primary folder can contain a damaged checkpoint. */ }
      if (pathIdentity(stagedNativeDirectory(home, sessionId), "directory") ||
          (saved?.codeContinuation && hasSplitHistory(dirname(home), sessionId))) return false;
      verified = saved ? saved.id === sessionId && matchesHistory(saved, scope, storage)
        : storage === scope.home && (existsSync(join(directory, "session.json")) || existsSync(join(directory, "session.prev.json")));
      return verified;
    });
    return { ...reply, result: "deleted" };
  } catch (error) {
    return { ...reply, result: error instanceof SessionLockedError ? "locked" : verified ? "unconfirmed" : "unavailable" };
  } finally {
    unlockProject?.();
  }
}

parent.on("message", ({ data }: { data: WorkerCommand }) => {
  if (DESKTOP_FIXTURE_ALLOWED && data.type === "clean-deleted-history") {
    cleanDeletedHistory(data.protectedRoot);
  } else if (data.type === "read-change") {
    let checkoutAvailable = false;
    try { assertProjectRoot(data.project); checkoutAvailable = true; } catch { /* Only saved snapshots are available. */ }
    send({ type: "change-diff", requestId: data.requestId, inspection: readRecorded(data, (journal) =>
      readRecordedChange(journal, data.recordId, { checkoutAvailable })) });
  } else if (DESKTOP_FIXTURE_ALLOWED && data.type === "read-native-change") {
    let journal: Journal | undefined;
    let inspection: ChangeInspection | null = null;
    try {
      if (!active && readNativeCheckpoint(data.directory, data.taskId, data.project.path, data.provider)?.mode === "agent") {
        journal = openNativeEdits(data.directory, data.taskId, data.project);
        inspection = readRecordedChange(journal, data.recordId, { undoAvailable: false });
      }
    } catch { /* A moved or unreadable record has no verified diff. */ }
    finally { journal?.release(); }
    send({ type: "change-diff", requestId: data.requestId, inspection });
  } else if (data.type === "read-command") {
    send({ type: "command-detail", requestId: data.requestId, inspection: readRecorded(data, (journal) => journalCommand(journal.state, data.recordId)) });
  } else if (data.type === "check-recovery" || (DESKTOP_FIXTURE_ALLOWED && data.type === "check-native-recovery")) {
    void checkRecovery(data).then(send);
  } else if (data.type === "compact-history") {
    void compactRecorded(data).then(send);
  } else if (data.type === "cancel-recovery") {
    if (recovery?.requestId === data.requestId) recovery.abort.abort();
  } else if (data.type === "undo-change") {
    send(undoRecordedChange(data));
  } else if (data.type === "plan-rewind") {
    send(planRecordedRewind(data));
  } else if (data.type === "rewind-history") {
    send(rewindRecorded(data));
  } else if (data.type === "fork-history") {
    send(forkRecorded(data));
  } else if (data.type === "delete-history") {
    send(deleteRecordedHistory(data));
  } else if (data.type === "discard-transient") {
    if (transient?.journal.state.id === data.sessionId) transient = undefined;
  } else if (data.type === "catalog") {
    void gatewayFor(data.connection).models().then((catalog) => {
      send({ type: "catalog", requestId: data.requestId, models: catalog.filter(supportsCodeApi).map(({ id, name, provider, reasoningEfforts }) => ({
        id, name, provider, efforts: reasoningEfforts ?? [],
      })) });
    }).catch(() => send({ type: "catalog-failed", requestId: data.requestId }));
  } else if (data.type === "start" || data.type === "resume") {
    void execute(data);
  } else if (DESKTOP_FIXTURE_ALLOWED && data.type === "start-codex-fixture") {
    void executeCodexFixture(data);
  } else if (DESKTOP_FIXTURE_ALLOWED && (data.type === "start-claude-fixture" || data.type === "start-structured-cli-fixture")) {
    void executeStructuredFixture(data);
  } else if (data.type === "follow-up") {
    void followUp(data);
  } else if (data.type === "queue") {
    let ok = false;
    try { ok = active?.runId === data.runId && active.queueOperation?.(data.operation) === true; }
    catch { /* A changed root or unwritable checkpoint cannot accept the change. */ }
    send({ type: "queue-result", runId: data.runId, requestId: data.requestId, ok });
  } else if (data.type === "stop-background" && active?.runId === data.runId) {
    const runner = active.runner;
    if (runner && /^bg-[0-9a-f]{6}$/.test(data.handle)) void runner.background.stop(data.handle).then(() => active?.refresh?.(), () => undefined);
  } else if (data.type === "stop" && active?.runId === data.runId) {
    active.cancelled = true;
    active.abort.abort();
    active.runner?.cancel();
    active.approval?.settle("deny");
  } else if (data.type === "code-plugin-result" && active?.runId === data.runId) {
    if (active.pluginRequest?.requestId === data.requestId) active.pluginRequest.settle(data.result);
  } else if (data.type === "git-action-result" && active?.runId === data.runId) {
    if (active.gitRequest?.requestId === data.requestId) active.gitRequest.settle(data.result);
  } else if (data.type === "browser-snapshot-result" && active?.runId === data.runId) {
    if (active.browserSnapshot?.requestId === data.requestId) active.browserSnapshot.settle(data.text);
  } else if (data.type === "answer" && active?.runId === data.runId) {
    const approval = active.approval;
    if (!approval || approval.id !== data.decision.id || (data.decision.action === "run" && !approval.canRemember)) return;
    approval.settle(data.decision.action);
  }
});
