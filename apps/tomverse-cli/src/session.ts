import { createHash, randomBytes } from "node:crypto";
import {
    chmodSync,
    closeSync,
    copyFileSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
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
    purpose: "agent" | "compact";
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
    error?: { kind: string; code?: string; message: string };
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
    binding: { files?: Array<{ path: string; preimage: string | null }>; cwd?: string; program?: string };
    decision: "approved" | "denied";
    /** Approved without asking, by an earlier "always" answer in the same process. */
    by?: "remembered_answer";
    rule?: "file_edits" | "same_command";
    /** This answer was "always" for the rest of that process. */
    remember?: "file_edits" | "same_command";
    decidedAt: string;
};

export type ToolRecord = {
    toolCallId: string;
    toolName: string;
    inputDigest: string;
    state: "started" | "completed" | "failed";
    startedAt: string;
    endedAt?: string;
    /** The bounded result the model received, so it can be given back without re-running. */
    output?: unknown;
};

export type ChangeRecord = {
    changeId: string;
    toolCallId: string;
    path: string;
    kind: "create" | "update" | "delete";
    /** mode: the permission bits before the change (POSIX), restored by undo. */
    preimage: { sha256: string | null; backup: string | null; mode?: number };
    postimage: { sha256: string | null };
    state: "writing" | "applied" | "failed" | "undone";
    appliedAt?: string;
    undoneAt?: string;
};

export type PendingApproval = { approvalId: string; toolCallId: string; toolName: string; input: unknown };

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
    limits: { maxRequests: number; timeoutMs: number; commandTimeoutMs: number };
    usage: { requests: number; activeMs: number };
    messages: ModelMessage[];
    compactions: Array<{ at: string; requestSeq: number; replacedMessages: number }>;
    generations: GenerationRecord[];
    approvals: ApprovalRecord[];
    tools: ToolRecord[];
    changes: ChangeRecord[];
    pendingApprovals: PendingApproval[];
    /**
     * One entry per user prompt. Limits apply per task and are never reset by
     * an approval, a compaction or a resume; `allowance` grows only when the
     * user agrees to continue past a limit.
     */
    tasks: Array<{
        effort?: import("./effort.js").Effort;
        prompt: string;
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
        io: JournalIo = { writeFileAtomic }
    ) {
        const id = Journal.newId();
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
        const dir = join(sessionsDir(home), id);
        const sessionsCreated = !existsSync(sessionsDir(home));
        mkdirSync(join(dir, "backups"), { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") {
            // The sessions folder only when the CLI created it; each session's own folder always.
            if (sessionsCreated) chmodSync(sessionsDir(home), 0o700);
            chmodSync(dir, 0o700);
            chmodSync(join(dir, "backups"), 0o700);
        }
        const journal = new Journal(state, dir, io);
        journal.acquireLock();
        journal.commit();
        return journal;
    }

    static open(home: string, id: string, io: JournalIo = { writeFileAtomic }) {
        if (!/^s-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(id)) throw new JournalError(`'${id}' is not a session id.`);
        const dir = join(sessionsDir(home), id);
        if (!existsSync(join(dir, "session.json"))) throw new JournalError(`No session ${id}.`);
        const journal = new Journal(Journal.read(dir), dir, io);
        journal.acquireLock();
        // Re-read under the lock: another writer may have just finished.
        Object.assign(journal.state, Journal.read(dir));
        return journal;
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

    saveBackup(changeId: string, bytes: Buffer) {
        if (this.broken) throw this.broken;
        const name = `${changeId}.pre`;
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

export const listSessions = (home: string): SessionSummary[] => {
    const dir = sessionsDir(home);
    if (!existsSync(dir)) return [];
    const out: SessionSummary[] = [];
    for (const id of readdirSync(dir)) {
        const path = join(dir, id);
        if (!statSync(path).isDirectory()) continue;
        try {
            const state = Journal.read(path);
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
            out.push({ id, root: "?", model: "?", status: "unreadable", requests: 0, updatedAt: "", firstTask: "", readable: false });
        }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
};

/** Deletes a session folder and its backups. The caller has confirmed. */
export const deleteSession = (home: string, id: string) => {
    if (!/^s-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(id)) throw new JournalError(`'${id}' is not a session id.`);
    const dir = join(sessionsDir(home), id);
    if (!existsSync(dir)) throw new JournalError(`No session ${id}.`);
    // Held while removing, so no process opens the session meanwhile.
    claimLock(join(dir, "lock"), id);
    rmSync(dir, { recursive: true, force: true });
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
