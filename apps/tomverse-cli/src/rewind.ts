import { canComplete } from "./task-plan.js";
import { undoChange, UndoError, viewChange } from "./changes.js";
import { Journal, JournalError, type ChangeRecord, type CheckpointRecord, type SessionState } from "./session.js";
import type { ModelMessage } from "ai";

/**
 * Turn by turn history. Each user message of a session (a task's prompt, or a follow-up sent while it ran) is a turn, and the
 * session recorded where the conversation and the list of file changes stood just before it.
 *
 * Rewinding to a turn takes that message and everything after it out: the files this session changed since then are put back,
 * newest first, each one only if it is still exactly what the session wrote (a file the person edited since is left alone and
 * reported as a conflict, the same rule as undoing one change), and the conversation is cut back to that point. Commands cannot
 * be taken back: the ones that ran in the part taken out are listed so the person knows. The conversation alone or the files
 * alone can be rewound too; the model is told what was and was not undone, so its next request does not rest on a wrong picture.
 *
 * Forking copies the conversation through a turn into a new session and touches no file. The new session starts with no changes
 * of its own to undo, and the original is left exactly as it was.
 */

export class RewindError extends Error {}

export type RewindMode = "both" | "files" | "conversation";

export type RewindTurn = {
    /** Position in the session's list of turns, from 0. */
    index: number;
    kind: CheckpointRecord["kind"];
    text: string;
    at: string;
    /** Whether the conversation can be cut back to this turn (it cannot once a compaction folded the message into a summary). */
    conversation: boolean;
    /** Changes the session made from this turn on that are still in place. */
    changes: number;
    commands: number;
};

export type RewindCommand = { toolCallId: string; display: string; status: string; exitCode?: number | null; background?: boolean };
export type RewindFile = { changeId: string; path: string; kind: string; outcome: "will_undo" | "conflict"; reason?: string };

export type RewindPlan = {
    turn: number;
    text: string;
    /** Newest change first: the order the files are put back in. */
    files: RewindFile[];
    commands: RewindCommand[];
    conversationAvailable: boolean;
    /** Why nothing can be rewound now. */
    blocked?: string;
};

export type RewindOutcome = {
    turn: number;
    /** The message that was taken out, to be edited and sent again. */
    text: string;
    mode: RewindMode;
    conversationCut: boolean;
    undone: Array<{ changeId: string; path: string }>;
    conflicts: Array<{ changeId: string; path: string; reason: string }>;
    commands: RewindCommand[];
};

type Hooks = {
    /** Called right before a file is written back (the host checks the project is still the one it started in). */
    beforeWrite?: (absolute: string) => void;
    /** Desktop only undoes a change whose file identity was recorded. */
    requireIdentity?: boolean;
    /** Redacts text that goes into the note for the model. */
    redactText?: (text: string) => string;
};

const NOTE_PATHS = 20;
const NOTE_COMMANDS = 8;

const checkpointsOf = (state: SessionState) => state.checkpoints ?? [];

/** Why a session cannot be rewound or forked right now, or undefined. */
export const historyBlockReason = (state: SessionState): string | undefined => {
    if (state.status === "running") return "The session is running. Stop it first.";
    if (state.pendingApprovals.length) return "The session is waiting for an approval. Answer it first.";
    if (state.changes.some((change) => change.state === "writing") || state.tools.some((tool) => tool.state === "started")) {
        return "A change or command of this session did not finish, so its result is not known. Check it first (resume the session).";
    }
    if (state.generations.some((generation) => !generation.closed)) return "A model request of this session has an unknown outcome. Look it up first (resume the session).";
    if (state.codeContinuation) return "A continuation session cannot be rewound or forked.";
    return undefined;
};

const commandsFrom = (state: SessionState, toolStart: number): RewindCommand[] =>
    state.tools.slice(toolStart).flatMap((tool): RewindCommand[] => {
        if (tool.toolName !== "run_command" || !tool.command) return [];
        const output = tool.output && typeof tool.output === "object" ? tool.output as { status?: unknown; exitCode?: unknown; background?: unknown } : {};
        const display = [tool.command.file, ...tool.command.args].join(" ").slice(0, 300);
        return [{
            toolCallId: tool.toolCallId, display, status: typeof output.status === "string" ? output.status : tool.state,
            ...(typeof output.exitCode === "number" || output.exitCode === null ? { exitCode: output.exitCode as number | null } : {}),
            ...(output.background === true ? { background: true } : {}),
        }];
    });

export const listTurns = (journal: Journal): RewindTurn[] => {
    const { state } = journal;
    return checkpointsOf(state).map((mark, index) => ({
        index, kind: mark.kind, text: mark.text, at: mark.at, conversation: mark.messageIndex !== null,
        changes: state.changes.slice(mark.changeStart).filter((change) => change.state === "applied").length,
        commands: commandsFrom(state, mark.toolStart).length,
    }));
};

/** What a rewind to this turn would do, without doing it: the files in the order they come back, the likely conflicts, the commands that stay done. */
export const planRewind = (journal: Journal, turn: number, requireIdentity = false): RewindPlan => {
    const { state } = journal;
    const mark = checkpointsOf(state)[turn];
    if (!mark) return { turn, text: "", files: [], commands: [], conversationAvailable: false, blocked: `There is no turn ${turn + 1} in this session.` };
    const plan: RewindPlan = {
        turn, text: mark.text, files: [], commands: commandsFrom(state, mark.toolStart), conversationAvailable: mark.messageIndex !== null,
    };
    const blocked = historyBlockReason(state);
    if (blocked) return { ...plan, blocked };
    // Newest first. A file comes back only if what the session wrote is still there, and only after every later change to it came back.
    const stuck = new Set<string>();
    // Where a file will be once the newer change to it has been put back: an earlier change is checked against that, not against the disk.
    const restored = new Map<string, ChangeRecord>();
    const normalize = (path: string) => path.replaceAll("\\", "/");
    for (const change of state.changes.slice(mark.changeStart).reverse()) {
        if (change.state !== "applied") continue;
        const file = { changeId: change.changeId, path: change.path, kind: change.kind };
        if (stuck.has(normalize(change.path))) {
            plan.files.push({ ...file, outcome: "conflict", reason: "A later change to this file cannot be put back first." });
            continue;
        }
        const later = restored.get(normalize(change.path));
        const expected = later ? later.preimage.sha256 === change.postimage.sha256 : viewChange(journal, change).current === "as_written";
        const identityMissing = requireIdentity && (!change.directory || change.postimage.identity === undefined);
        const reason = identityMissing ? "This record lacks the file identity needed for a verified undo."
            : !expected ? `${change.path} changed after the session wrote it.`
            : change.kind !== "create" && !change.preimage.backup ? "No copy of the earlier content was kept." : undefined;
        if (reason) {
            stuck.add(normalize(change.path));
            plan.files.push({ ...file, outcome: "conflict", reason });
        } else {
            restored.set(normalize(change.path), change);
            plan.files.push({ ...file, outcome: "will_undo" });
        }
    }
    return plan;
};

/** The call ids of the tool calls (and approvals) in a conversation, to tell which evidence of a plan is still part of it. */
const callIdsIn = (messages: ModelMessage[]) => {
    const ids = new Set<string>();
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content as Array<Record<string, unknown>>) {
            if (part.type === "tool-call") ids.add(String(part.toolCallId));
        }
    }
    return ids;
};

const listed = (items: string[], limit: number) => items.slice(0, limit).join(", ") + (items.length > limit ? `, and ${items.length - limit} more` : "");

/**
 * Takes the history back to just before a turn. `files` puts back what the session changed (conflicts are reported, never forced);
 * `conversation` cuts the conversation; `both` does both and does nothing when the conversation cannot be cut. The model gets a note
 * saying what was and was not undone.
 */
export const rewindSession = (journal: Journal, turn: number, mode: RewindMode = "both", hooks: Hooks = {}): RewindOutcome => {
    const { state } = journal;
    const plan = planRewind(journal, turn, hooks.requireIdentity);
    if (plan.blocked) throw new RewindError(plan.blocked);
    const mark = checkpointsOf(state)[turn]!;
    const cut = mode !== "files";
    if (cut && mark.messageIndex === null) {
        throw new RewindError("The conversation at that point was folded into a summary (compaction), so it cannot be cut back there. Rewind the files only, or choose a later turn.");
    }
    if (cut) {
        const dangling = danglingToolCall(state.messages.slice(0, mark.messageIndex!));
        if (dangling) throw new RewindError(`The conversation at that point ends in the middle of a tool call (${dangling}), so it cannot be cut there. Choose another turn.`);
    }
    const outcome: RewindOutcome = { turn, text: mark.text, mode, conversationCut: false, undone: [], conflicts: [], commands: plan.commands };
    if (mode !== "conversation") {
        for (const change of [...state.changes.slice(mark.changeStart)].reverse()) {
            if (change.state !== "applied") continue;
            try {
                undoChange(journal, change.changeId, hooks.beforeWrite, hooks.requireIdentity);
                outcome.undone.push({ changeId: change.changeId, path: change.path });
            } catch (error) {
                if (error instanceof JournalError || journal.broken) throw journal.broken ?? error;
                outcome.conflicts.push({ changeId: change.changeId, path: change.path, reason: error instanceof UndoError ? error.message : `Failed: ${(error as Error).message}` });
            }
        }
    }
    const remaining = state.changes.slice(mark.changeStart).filter((change) => change.state === "applied").map((change) => change.path);
    if (cut) {
        const task = state.tasks[mark.task];
        state.messages.length = mark.messageIndex!;
        state.checkpoints = checkpointsOf(state).slice(0, turn);
        if (mark.kind === "prompt") state.tasks.length = mark.task;
        else if (task) {
            task.followUps = (task.followUps ?? []).filter((entry) => entry.messageIndex === null || (typeof entry.messageIndex === "number" && entry.messageIndex < mark.messageIndex!));
            task.queued = [];
            // The plan outlives the messages that built it: what rests on work that was taken out no longer stands.
            if (task.plan) {
                const kept = callIdsIn(state.messages);
                for (const item of task.plan.items) {
                    const before = item.evidence.length;
                    item.evidence = item.evidence.filter((entry) => kept.has(entry.callId));
                    if (item.evidence.length !== before) {
                        item.evidenceStart = Math.min(item.evidenceStart ?? 0, item.evidence.length);
                        if (item.complete && !canComplete(item.evidence, item.evidenceStart)) item.complete = false;
                    }
                }
            }
        }
        const last = state.tasks.at(-1);
        if (last) {
            last.status = "completed";
            last.endedAt ??= new Date().toISOString();
        }
        // Nothing runs, and a session with nothing left in it is not one that stopped unexpectedly.
        state.status = "completed";
        delete state.lastError;
        delete state.pendingResendOf;
        if ((state.compactionFailedForTask ?? 0) > state.tasks.length) delete state.compactionFailedForTask;
        outcome.conversationCut = true;
    }
    // Tell the model what the folder looks like now, so its next request does not rest on history that no longer matches.
    const clean = (text: string) => hooks.redactText?.(text) ?? text;
    const lines: string[] = [];
    if (mode === "files") lines.push(`The user rewound the files this session changed since the message "${clean(mark.text.slice(0, 120))}": ${outcome.undone.length ? `put back: ${listed(outcome.undone.map((item) => clean(item.path)), NOTE_PATHS)}` : "nothing was put back"}. The conversation above still describes those edits, but they are not in the folder any more.`);
    else if (mode === "conversation") lines.push(`The user rewound this conversation to before the message "${clean(mark.text.slice(0, 120))}". The files were NOT put back: ${remaining.length ? `these still hold the edits of the removed part: ${listed([...new Set(remaining.map(clean))], NOTE_PATHS)}` : "the removed part did not change any file"}. Look at the files before relying on them.`);
    else if (outcome.undone.length || outcome.conflicts.length) {
        lines.push(`The user rewound this conversation to before the message "${clean(mark.text.slice(0, 120))}" and put the files back${outcome.undone.length ? `: ${listed(outcome.undone.map((item) => clean(item.path)), NOTE_PATHS)}` : ""}.`);
    }
    if (outcome.conflicts.length) lines.push(`These files were NOT put back (they changed since, or a later edit could not be taken back first): ${listed([...new Set(outcome.conflicts.map((item) => clean(item.path)))], NOTE_PATHS)}.`);
    if (plan.commands.length) lines.push(`Commands that ran in the removed part cannot be taken back; their effects (outside the files above) may still be there: ${listed(plan.commands.map((item) => clean(item.display.slice(0, 120))), NOTE_COMMANDS)}.`);
    const needsNote = mode !== "both" || outcome.conflicts.length > 0 || plan.commands.length > 0;
    if (needsNote && lines.length) state.messages.push({ role: "user", content: `[Tomverse CLI] ${lines.join(" ")}` });
    (state.rewinds ??= []).push({
        at: new Date().toISOString(), turn, conversation: outcome.conversationCut,
        undone: outcome.undone.map((item) => item.changeId), conflicts: outcome.conflicts, commands: plan.commands.map((item) => item.display),
    });
    if (state.rewinds.length > 50) state.rewinds.splice(0, state.rewinds.length - 50);
    journal.commit();
    return outcome;
};

/** The copy a fork starts from: the same session settings, the conversation through a turn, and none of the original's records of work. */
export const forkSession = (home: string, source: Journal, throughTurn: number): { journal: Journal; turns: number } => {
    const { state } = source;
    if (!source.persisted) throw new RewindError("A session kept in memory only cannot be forked.");
    const blocked = historyBlockReason(state);
    if (blocked) throw new RewindError(blocked);
    const marks = checkpointsOf(state);
    const mark = marks[throughTurn];
    if (!mark) throw new RewindError(`There is no turn ${throughTurn + 1} in this session.`);
    const next = marks[throughTurn + 1];
    if (next && next.messageIndex === null) throw new RewindError("The conversation after that turn was folded into a summary (compaction), so it cannot be cut there. Choose a later turn.");
    const end = next ? next.messageIndex! : state.messages.length;
    const messages = structuredClone(state.messages.slice(0, end)) as ModelMessage[];
    const dangling = danglingToolCall(messages);
    if (dangling) throw new RewindError(`The conversation at that point ends in the middle of a tool call (${dangling}), so it cannot be copied there. Choose another turn.`);
    const tasks = structuredClone(state.tasks.slice(0, mark.task + 1));
    for (const [index, task] of tasks.entries()) {
        task.requests = 0;
        task.activeMs = 0;
        delete task.planAssignments;
        delete task.goalChecks;
        task.queued = [];
        task.status = "completed";
        task.endedAt ??= new Date().toISOString();
        if (index === tasks.length - 1) {
            task.followUps = (task.followUps ?? []).filter((entry) => entry.messageIndex === null || (typeof entry.messageIndex === "number" && entry.messageIndex < end));
        }
    }
    const journal = Journal.create(home, {
        workspace: { root: state.workspace.root },
        endpointOrigin: state.endpointOrigin,
        ...(state.endpointBase ? { endpointBase: state.endpointBase } : {}),
        ...(state.keyIdentity ? { keyIdentity: state.keyIdentity } : {}),
        keyPrefix: state.keyPrefix,
        readOnly: state.readOnly,
        ...(state.codeMode ? { codeMode: state.codeMode } : {}),
        ...(state.codePermission ? { codePermission: state.codePermission } : {}),
        model: { ...state.model },
        limits: { ...state.limits },
        ...(state.goal ? { goal: { ...state.goal } } : {}),
        forkedFrom: { sessionId: state.id, turns: throughTurn + 1, at: new Date().toISOString() },
    });
    try {
        journal.state.messages = messages;
        journal.state.tasks = tasks;
        journal.state.checkpoints = structuredClone(marks.slice(0, throughTurn + 1));
        // A summary the conversation starts with must stay recognisable as one.
        journal.state.compactions = structuredClone(state.compactions).map((entry) => ({ ...entry, requestSeq: 0 }));
        journal.state.status = tasks.length ? "completed" : "idle";
        journal.commit();
        return { journal, turns: throughTurn + 1 };
    } catch (error) {
        journal.release();
        throw error;
    }
};

/** A tool call in a conversation that has no result and no answer to its approval after it, or null. */
function danglingToolCall(messages: ModelMessage[]) {
    const answered = new Set<string>();
    const asked: string[] = [];
    const approvalOf = new Map<string, string>();
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content as Array<Record<string, unknown>>) {
            if (part.type === "tool-call") asked.push(String(part.toolCallId));
            if (part.type === "tool-result") answered.add(String(part.toolCallId));
            if (part.type === "tool-approval-request") approvalOf.set(String(part.approvalId), String(part.toolCallId));
            if (part.type === "tool-approval-response") {
                const call = approvalOf.get(String(part.approvalId));
                if (call) answered.add(call);
            }
        }
    }
    return asked.find((id) => !answered.has(id)) ?? null;
}
