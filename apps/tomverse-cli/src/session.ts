import { createHash, randomBytes } from "node:crypto";
import {
    chmodSync,
    closeSync,
    copyFileSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    rmdirSync,
    unlinkSync,
    linkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { Receipt } from "./gateway.js";

/**
 * The local session journal. One folder per session under
 * <TOMVERSE_HOME>/sessions, readable only by its owner, holding one JSON
 * checkpoint that is rewritten atomically (temp file, fsync, rename) before
 * and after every side effect: before a model request is sent, before and
 * after a file write or command. If a checkpoint cannot be written, the
 * caller stops: no new request, write or command starts without a record.
 *
 * What is stored: the conversation (which includes file contents and command
 * output the model saw), request ids, approvals, tool states and the
 * pre-change bytes of files the CLI changed (for undo). Never the API key.
 * Nothing is uploaded anywhere. --no-persist keeps all of it in memory only.
 */

export const SESSION_SCHEMA_VERSION = 1;

export type GenerationRecord = {
    seq: number;
    purpose: "agent" | "compact" | "goal" | "subagent";
    /** The subagent run this request was made for (purpose "subagent"). */
    subagentId?: string;
    idempotencyKey: string;
    /**
     * intent: recorded, maybe sent, no answer seen (unknown until looked up).
     * headers: the server answered with a status. complete / interrupted:
     * the body was read to its end / broke off. failed: no HTTP answer.
     */
    state: "intent" | "headers" | "complete" | "interrupted" | "failed";
    httpStatus?: number;
    requestId?: string | null;
    routedModel?: string | null;
    catalogProvider?: string;
    appliedEffort?: import("./effort.js").Effort;
    transmission?: import("./transmission.js").RequestTransmission;
    error?: { kind: string; code?: string; message: string; resetAt?: string };
    receipt?: Receipt | null;
    lookup?: "found" | "not_found";
    lookupAt?: string;
    /** A request the user chose to send again after an unknown outcome. */
    resendOf?: number;
    /**
     * Nothing more to do for this request: its answer is in the saved history
     * (set in the same checkpoint), the API refused it, or the user acknowledged
     * that its answer is lost or unknown. Anything not closed is unresolved.
     */
    closed?: boolean;
    createdAt: string;
    updatedAt: string;
};

export type ApprovalRecord = {
    approvalId: string;
    toolCallId: string;
    toolName: string;
    inputDigest: string;
    /** What the decision was bound to, checked again right before execution. */
    binding: {
        files?: Array<{ path: string; preimage: string | null; disk?: import("./patch.js").FileBinding }>;
        cwd?: string;
        program?: string;
        envNames?: string[];
        /** The command was approved as one that keeps running in the background. */
        background?: boolean;
        /** The web page request was approved for this site. */
        host?: string;
        /** The MCP tool call was approved for this server definition (its hash); a changed definition is not run. */
        mcp?: { server: string; tool: string; definition: string };
    };
    decision: "approved" | "denied";
    /** Approved without asking, by an earlier "always" answer in the same process. */
    by?: "remembered_answer";
    rule?: "file_edits" | "same_command" | "web_host" | "mcp_tool";
    /** This answer was "always" for the rest of that process. */
    remember?: "file_edits" | "same_command" | "web_host" | "mcp_tool";
    decidedAt: string;
};

/** A command a task kept running in the background, and how it ended. Processes never outlive the task that started them. */
export type BackgroundRecord = {
    handle: string;
    toolCallId: string;
    display: string;
    cwd: string;
    startedAt: string;
    state: "running" | "exited" | "stopped";
    endedAt?: string;
    exitCode?: number | null;
    endReason?: "exited" | "stopped" | "task_ended" | "failed_to_start";
    /** Which run of the CLI started it; a record from another run is one a resume tells the model about. */
    epoch: string;
    /** The model has been told how it ended. */
    acknowledged?: boolean;
};

/**
 * One run of a subagent (the delegate tool): what it was asked, how far it got, and what became of it. Its requests are in
 * `generations` (purpose "subagent") and count against the task's limits like any other request; its conversation is not kept.
 */
export type SubagentRecord = {
    id: string;
    toolCallId: string;
    kind: "explore" | "worker";
    /** The assignment the main agent gave, shortened. */
    task: string;
    /** unknown: the process ended while it ran, so what it did is not known (files it changed are still in `changes`). */
    state: "running" | "completed" | "failed" | "cancelled" | "limit" | "unknown";
    requests: number;
    startedAt: string;
    endedAt?: string;
    /** Which run of the CLI started it; a record from another run is one a resume tells the model about. */
    epoch: string;
    /** The first part of its report, or why it failed. */
    summary?: string;
    filesRead?: string[];
    filesChanged?: string[];
    /** The model has been told how it ended after a resume. */
    acknowledged?: boolean;
};

/**
 * The start of one user message (a task's prompt, or a follow-up sent while it ran): where the conversation and the list of
 * file changes stood just before it. Rewinding to it cuts the conversation back to `messageIndex` and undoes the changes from
 * `changeStart` on; forking copies the conversation before the message that came after it.
 */
export type CheckpointRecord = {
    kind: "prompt" | "follow_up";
    /** Index into `tasks` of the task the message belongs to. */
    task: number;
    /** Position of the message in the saved messages; null once a compaction folded it into a summary. */
    messageIndex: number | null;
    changeStart: number;
    toolStart: number;
    at: string;
    /** The first part of the message, to tell the turns apart in a list. */
    text: string;
};

/** A rewind that was carried out, kept so the session says what happened to its history. */
export type RewindRecord = {
    at: string;
    /** The turn rewound to (its message and everything after it were taken out). */
    turn: number;
    conversation: boolean;
    undone: string[];
    conflicts: Array<{ changeId: string; path: string; reason: string }>;
    /** Commands that ran in the part that was taken out: their effects cannot be undone. */
    commands: string[];
};

export type ToolRecord = {
    toolCallId: string;
    toolName: string;
    inputDigest: string;
    state: "started" | "completed" | "failed";
    startedAt: string;
    endedAt?: string;
    /** Actual spawn plan with environment names and no environment values. */
    command?: Omit<import("./commands.js").CommandPlan, "shell" | "display">;
    /** The bounded result the model received, so it can be given back without re-running. */
    output?: unknown;
};

export type ChangeRecord = {
    changeId: string;
    toolCallId: string;
    path: string;
    kind: "create" | "update" | "delete";
    /** mode: the permission bits before the change (POSIX), restored by undo. */
    preimage: { sha256: string | null; backup: string | null; mode?: number; identity?: string | null };
    postimage: { sha256: string | null; backup?: string | null; identity?: string | null };
    directory?: string;
    state: "writing" | "applied" | "failed" | "undone";
    appliedAt?: string;
    undoneAt?: string;
};

export type PendingApproval = { approvalId: string; toolCallId: string; toolName: string; input: unknown; blockedDuringAnalysis?: true };

export type SessionStatus =
    | "idle"
    | "running"
    | "completed"
    | "needs_approval"
    | "error"
    | "cancelled"
    | "limit_reached"
    | "unknown_outcome";

export type SessionState = {
    schemaVersion: number;
    id: string;
    createdAt: string;
    updatedAt: string;
    workspace: { root: string };
    endpointOrigin: string;
    /** Full API base and non-secret credential identity for embedded hosts. */
    endpointBase?: string;
    keyIdentity?: string;
    codeContinuation?: { segmentId: string; maximumKeyCreditCap: number };
    codeMode?: "ask" | "plan" | "agent";
    codePermission?: "desktop-accept-edits-v1";
    /** The key's public prefix: lookups are scoped to the key that sent a request. */
    keyPrefix: string;
    readOnly: boolean;
    model: {
        requested: string;
        /** The model every request of this session uses once known. */
        pinned: string | null;
        pinnedFrom: "user" | "smart_adaptive_first_response" | null;
        contextWindowTokens: number;
        maxOutputTokens: number;
    };
    /** profile: the named limit set the numbers came from; absent on sessions written before profiles existed (standard). */
    limits: { maxRequests: number; timeoutMs: number; commandTimeoutMs: number; profile?: "standard" | "extended" | "unlimited" };
    /**
     * Goal mode, chosen when the session started: after the model says it is
     * done, one more request asks whether the goal is verified, and an unmet
     * goal continues on its own, at most `maxContinuations` times in a row.
     */
    goal?: { maxContinuations: number };
    usage: { requests: number; activeMs: number };
    messages: ModelMessage[];
    compactions: Array<{ at: string; requestSeq: number; replacedMessages: number }>;
    generations: GenerationRecord[];
    approvals: ApprovalRecord[];
    tools: ToolRecord[];
    changes: ChangeRecord[];
    background?: BackgroundRecord[];
    subagents?: SubagentRecord[];
    /** One entry per user message, in order. Absent on sessions saved before checkpoints existed (they cannot be rewound or forked). */
    checkpoints?: CheckpointRecord[];
    rewinds?: RewindRecord[];
    /** Where this session was forked from: the session and how many of its turns were copied. */
    forkedFrom?: { sessionId: string; turns: number; at: string };
    pendingApprovals: PendingApproval[];
    /**
     * One entry per user prompt. Limits apply per task and are never reset by
     * an approval, a compaction or a resume; `allowance` grows only when the
     * user agrees to continue past a limit.
     */
    tasks: Array<{
        effort?: import("./effort.js").Effort;
        prompt: string;
        references?: import("./workspace.js").WorkspaceReference[];
        plan?: import("./task-plan.js").TaskPlan;
        /** Model routing at accepted plan activations, kept outside the plan for older journal readers. */
        planAssignments?: import("./task-plan.js").TaskPlanAssignments;
        /** A missing index is queued. A null index was included before compaction. */
        followUps?: Array<{ text: string; messageIndex?: number | null; /** Written by goal mode, not by the person. */ auto?: boolean }>;
        /** Messages held for after the model finishes: the first one becomes a follow-up when it does. */
        queued?: Array<{ id: string; text: string }>;
        /** Automatic continuations goal mode has made in this task, and what each check said. */
        goalContinuations?: number;
        goalChecks?: Array<{ at: string; met: boolean; summary: string; next?: string; continuation: number }>;
        startedAt: string;
        endedAt?: string;
        status?: SessionStatus;
        requests: number;
        activeMs: number;
        allowance: number;
        timeAllowanceMs: number;
    }>;
    status: SessionStatus;
    lastError?: string;
    /** Set when the user chose to send a step again after an unknown outcome. */
    pendingResendOf?: number;
    /** Task number whose automatic compaction failed; not tried again in that task. */
    compactionFailedForTask?: number;
};

export class JournalError extends Error {}
export class SessionLockedError extends Error {}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** A digest of a JSON value that does not depend on key order. */
export const canonicalDigest = (value: unknown) => sha256(canonicalJson(value));
const canonicalJson = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
};

export const sessionsDir = (home: string) => join(home, "sessions");

const now = () => new Date().toISOString();

/** Writes bytes so that a reader sees either the old file or the new one. */
export const writeFileAtomic = (path: string, data: string | Buffer) => {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
        writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    try {
        renameSync(tmp, path);
    } catch (error) {
        try {
            unlinkSync(tmp);
        } catch {
            // best effort
        }
        throw error;
    }
};

export type JournalIo = { writeFileAtomic: typeof writeFileAtomic };

const processAlive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

export class Journal {
    private lockPath: string | null = null;

    private constructor(
        readonly state: SessionState,
        readonly dir: string | null,
        private readonly io: JournalIo
    ) {}

    get persisted() {
        return this.dir !== null;
    }

    static newId() {
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
        return `s-${stamp}-${randomBytes(3).toString("hex")}`;
    }

    static create(
        home: string | null,
        init: Omit<SessionState, "schemaVersion" | "id" | "createdAt" | "updatedAt" | "usage" | "messages" | "compactions" | "generations" | "approvals" | "tools" | "changes" | "pendingApprovals" | "tasks" | "status">,
        io: JournalIo = { writeFileAtomic },
        id = Journal.newId(),
    ) {
        if (!/^s-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(id)) throw new JournalError("Invalid session id.");
        const state: SessionState = {
            schemaVersion: SESSION_SCHEMA_VERSION,
            id,
            createdAt: now(),
            updatedAt: now(),
            ...init,
            usage: { requests: 0, activeMs: 0 },
            messages: [],
            compactions: [],
            generations: [],
            approvals: [],
            tools: [],
            changes: [],
            pendingApprovals: [],
            tasks: [],
            status: "idle",
        };
        if (home === null) return new Journal(state, null, io);
        const parent = sessionsDir(home);
        const dir = join(parent, id);
        const sessionsCreated = !existsSync(parent);
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        mkdirSync(dir, { mode: 0o700 });
        mkdirSync(join(dir, "backups"), { mode: 0o700 });
        if (process.platform !== "win32") {
            // The sessions folder only when the CLI created it; each session's own folder always.
            if (sessionsCreated) chmodSync(sessionsDir(home), 0o700);
            chmodSync(dir, 0o700);
            chmodSync(join(dir, "backups"), 0o700);
        }
        const journal = new Journal(state, dir, io);
        journal.acquireLock();
        try {
            journal.commit();
            return journal;
        } catch (error) {
            journal.release();
            try {
                rmdirSync(join(dir, "backups"));
                rmdirSync(dir);
            } catch { /* Preserve an existing checkpoint or backup. */ }
            throw error;
        }
    }

    static open(home: string, id: string, io: JournalIo = { writeFileAtomic }) {
        if (!/^s-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(id)) throw new JournalError(`'${id}' is not a session id.`);
        const dir = join(sessionsDir(home), id);
        if (!existsSync(join(dir, "session.json"))) throw new JournalError(`No session ${id}.`);
        const lock = join(dir, "lock");
        claimLock(lock, id);
        try {
            const state = Journal.read(dir);
            if (state.id !== id) throw new JournalError(`Session ${id} does not match its checkpoint.`);
            const journal = new Journal(state, dir, io);
            journal.lockPath = lock;
            return journal;
        } catch (error) {
            try { unlinkSync(lock); } catch { /* Keep the checkpoint error. */ }
            throw error;
        }
    }

    /** Reads a checkpoint; falls back to the previous one only to report, never silently. */
    static read(dir: string): SessionState {
        const path = join(dir, "session.json");
        let parsed: SessionState;
        try {
            parsed = JSON.parse(readFileSync(path, "utf8")) as SessionState;
        } catch {
            const previous = join(dir, "session.prev.json");
            throw new JournalError(
                `The session checkpoint ${path} cannot be read.${existsSync(previous) ? ` The previous checkpoint is kept at ${previous}.` : ""} It was not changed.`
            );
        }
        if (parsed.schemaVersion !== SESSION_SCHEMA_VERSION) {
            throw new JournalError(`Session ${parsed.id} was written by another CLI version (schema ${parsed.schemaVersion}).`);
        }
        return parsed;
    }

    private acquireLock() {
        if (!this.dir) return;
        const lockPath = join(this.dir, "lock");
        claimLock(lockPath, this.state.id);
        this.lockPath = lockPath;
    }

    release() {
        if (this.lockPath) {
            try {
                unlinkSync(this.lockPath);
            } catch {
                // already gone
            }
            this.lockPath = null;
        }
    }

    /**
     * Set once a checkpoint fails. From then on every commit throws, so no
     * request, write or command can start without a record -- even where the
     * first failure was caught and reported as a tool error.
     */
    broken: JournalError | null = null;

    /** Durable checkpoint. Throws JournalError; the caller must not proceed. */
    commit() {
        if (this.broken) throw this.broken;
        this.state.updatedAt = now();
        if (!this.dir) return;
        const path = join(this.dir, "session.json");
        try {
            if (existsSync(path)) copyFileSync(path, join(this.dir, "session.prev.json"));
            this.io.writeFileAtomic(path, JSON.stringify(this.state));
        } catch (error) {
            this.broken = new JournalError(`The session could not be saved (${(error as Error).message}). Stopped before doing anything else.`);
            throw this.broken;
        }
    }

    /** Keeps a file's bytes before the CLI changes it, for undo. */
    /** --no-persist keeps backups in memory: undo works until the process exits. */
    private readonly memoryBackups = new Map<string, Buffer>();

    saveBackup(changeId: string, bytes: Buffer, image: "pre" | "post" = "pre") {
        if (this.broken) throw this.broken;
        const name = `${changeId}.${image}`;
        if (!this.dir) {
            this.memoryBackups.set(name, Buffer.from(bytes));
            return name;
        }
        try {
            this.io.writeFileAtomic(join(this.dir, "backups", name), bytes);
        } catch (error) {
            throw new JournalError(`The backup for undo could not be saved (${(error as Error).message}). The file was not changed.`);
        }
        return name;
    }

    readBackup(name: string) {
        if (!/^[A-Za-z0-9_-]+\.(pre|post)$/.test(name)) throw new JournalError("Invalid recorded file snapshot.");
        if (!this.dir) return this.memoryBackups.get(name) ?? null;
        return readFileSync(join(this.dir, "backups", name));
    }

    // ---- generations -------------------------------------------------------

    newGeneration(purpose: GenerationRecord["purpose"], resendOf?: number): GenerationRecord {
        if (this.broken) throw this.broken;
        const seq = this.state.generations.length + 1;
        const record: GenerationRecord = {
            seq,
            purpose,
            // Unique per request; the session id makes it unique per key too.
            idempotencyKey: `tvcli-${this.state.id}-${seq}-${randomBytes(6).toString("hex")}`,
            state: "intent",
            ...(resendOf ? { resendOf } : {}),
            createdAt: now(),
            updatedAt: now(),
        };
        this.state.generations.push(record);
        this.state.usage.requests += 1;
        return record;
    }

    generation(idempotencyKey: string) {
        const record = this.state.generations.find((g) => g.idempotencyKey === idempotencyKey);
        if (!record) throw new JournalError("Unknown request record.");
        return record;
    }

    /**
     * Requests not closed: sent (or maybe sent) and their answer is not in the
     * history -- including one fully received just before the process died.
     */
    unresolvedGenerations() {
        return this.state.generations.filter((g) => !g.closed);
    }

    closeGenerations(records: GenerationRecord[]) {
        for (const record of records) record.closed = true;
    }
}

export type SessionSummary = {
    id: string;
    root: string;
    model: string;
    status: string;
    requests: number;
    updatedAt: string;
    firstTask: string;
    readable: boolean;
};

export const listSessions = (home: string, include: (state: SessionState) => boolean = () => true): SessionSummary[] => {
    const dir = sessionsDir(home);
    if (!existsSync(dir)) return [];
    const out: SessionSummary[] = [];
    for (const id of readdirSync(dir)) {
        const path = join(dir, id);
        try {
            if (!lstatSync(path).isDirectory() || (!existsSync(join(path, "session.json")) && !existsSync(join(path, "session.prev.json")))) continue;
            const state = Journal.read(path);
            if (state.id !== id || !include(state)) continue;
            out.push({
                id: state.id,
                root: state.workspace.root,
                model: state.model.pinned ?? state.model.requested,
                status: state.status,
                requests: state.usage.requests,
                updatedAt: state.updatedAt,
                firstTask: state.tasks[0]?.prompt.slice(0, 80) ?? "",
                readable: true,
            });
        } catch {
            if (!existsSync(path)) continue;
            out.push({ id, root: "?", model: "?", status: "unreadable", requests: 0, updatedAt: "", firstTask: "", readable: false });
        }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
};

/** Deletes a session folder and its backups. The caller has confirmed. */
export const deleteSession = (home: string, id: string, authorize?: (directory: string) => boolean) => {
    if (!/^s-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(id)) throw new JournalError(`'${id}' is not a session id.`);
    const location = sessionsDir(home);
    if (!existsSync(join(location, id))) throw new JournalError(`No session ${id}.`);
    const parent = realpathSync(location);
    const dir = join(parent, id);
    const original = lstatSync(dir, { bigint: true });
    const isOriginal = () => {
        const current = lstatSync(dir, { bigint: true });
        return current.isDirectory() && current.dev === original.dev && current.ino === original.ino && realpathSync(dir) === dir;
    };
    if (!isOriginal()) throw new JournalError(`Session ${id} does not resolve to a local record.`);
    const lock = join(dir, "lock");
    claimLock(lock, id);
    let ownsLock = true;
    try {
        if (authorize && !authorize(dir)) throw new JournalError(`Session ${id} could not be verified for deletion.`);
        const checkpoints = new Set(["session.json", "session.prev.json"]);
        const entries = readdirSync(dir).filter((name) => name !== "lock");
        for (const name of [...entries.filter((name) => !checkpoints.has(name)), ...entries.filter((name) => checkpoints.has(name))]) {
            if (!isOriginal()) throw new JournalError(`Session ${id} changed before deletion.`);
            rmSync(join(dir, name), { recursive: true });
        }
        if (!isOriginal()) throw new JournalError(`Session ${id} changed before deletion finished.`);
        unlinkSync(lock);
        ownsLock = false;
        rmdirSync(dir);
    } finally {
        try { if (ownsLock && isOriginal()) unlinkSync(lock); } catch { /* The record may already be gone. */ }
    }
};

/**
 * Takes a session's lock file, or throws SessionLockedError.
 *
 * A lock file is created whole: its content goes to a temporary file that is
 * hard-linked into place, which fails if a lock exists -- so there is never an
 * empty lock and never an overwrite. A lock left by a process that no longer
 * runs on this host is taken over under a second, also exclusive, ".reclaim"
 * guard: only its holder may remove the stale lock, after reading it again.
 * Any other process sees the lock still there and stops, so a live process's
 * lock is never removed. A guard left by a crashed reclaimer is not removed
 * automatically; the error names it.
 */
export const claimLock = (lockPath: string, id: string) => {
    const createExclusive = (path: string, content: string) => {
        const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        writeFileSync(tmp, content, { mode: 0o600 });
        try {
            linkSync(tmp, path);
        } finally {
            unlinkSync(tmp);
        }
    };
    const mine = () => JSON.stringify({ pid: process.pid, host: hostname(), at: now() });
    const locked = (holder: { pid?: number; host?: string }, extra = "") =>
        new SessionLockedError(
            `Session ${id} is open in another tomverse process${holder.pid ? ` (pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ""})` : ""}.${extra || ` If no tomverse process is using it (a reused process id can look alive), delete ${lockPath}.`}`
        );
    try {
        createExclusive(lockPath, mine());
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new JournalError(`Cannot lock the session: ${(error as Error).message}`);
    }
    let raw = "";
    let holder: { pid?: number; host?: string } = {};
    try {
        raw = readFileSync(lockPath, "utf8");
        holder = JSON.parse(raw);
    } catch {
        throw locked(holder);
    }
    const stale = holder.host === hostname() && typeof holder.pid === "number" && !processAlive(holder.pid);
    if (!stale) throw locked(holder);
    const guard = `${lockPath}.reclaim`;
    try {
        createExclusive(guard, mine());
    } catch {
        throw locked(holder, ` Another process is taking over its stale lock; if none is running, delete ${guard}.`);
    }
    try {
        // Under the guard no other process removes the lock, and none can create
        // one while it exists, so reading it again tells whether it is still
        // the stale one.
        if (readFileSync(lockPath, "utf8") !== raw) throw locked(holder);
        unlinkSync(lockPath);
        try {
            createExclusive(lockPath, mine());
        } catch {
            // Another process took the free lock first: it is theirs.
            throw locked({});
        }
    } finally {
        unlinkSync(guard);
    }
};
