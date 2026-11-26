import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { CommandError, killTree, killTreeSync, spawnPlanned, type CommandLaunch, type CommandPlan } from "./commands.js";

/**
 * Commands that keep running after the tool call that started them returned:
 * a dev server, a watcher. Each one was approved as a background command, and
 * the approval said so. They belong to the task that started them: when the
 * task ends, is stopped or cancelled, or the process exits, every process tree
 * left is ended the same way a timed-out command is.
 *
 * Output is kept in memory only, the most recent KEEP_BYTES of stdout and
 * stderr interleaved, and handed back in bounded pieces: each read returns what
 * was written since the previous read of that handle.
 */

export const BACKGROUND_LIMIT = 4;
const KEEP_BYTES = 256 * 1024;
export const BACKGROUND_READ_BYTES = 24 * 1024;
const SETTLE_MS = 1200;
const QUIET_MS = 250;

export type BackgroundState = "running" | "exited" | "stopped";
export type BackgroundEndReason = "exited" | "stopped" | "task_ended" | "failed_to_start";

export type BackgroundInfo = {
    handle: string;
    toolCallId: string;
    display: string;
    cwd: string;
    startedAt: string;
    state: BackgroundState;
    endedAt?: string;
    exitCode?: number | null;
    signal?: string | null;
    endReason?: BackgroundEndReason;
    residualProcesses?: number[];
    error?: string;
};

/** The newest bytes of a stream, addressed by absolute offset so a reader's place survives the oldest bytes being dropped. */
class OutputWindow {
    private chunks: Buffer[] = [];
    private held = 0;
    /** Absolute offset of the first byte still held. */
    private first = 0;
    total = 0;

    push(chunk: Buffer) {
        this.chunks.push(chunk);
        this.held += chunk.length;
        this.total += chunk.length;
        while (this.held > KEEP_BYTES && this.chunks.length > 1) {
            const dropped = this.chunks.shift()!;
            this.held -= dropped.length;
            this.first += dropped.length;
        }
        if (this.held > KEEP_BYTES) {
            const extra = this.held - KEEP_BYTES;
            this.chunks[0] = this.chunks[0]!.subarray(extra);
            this.held -= extra;
            this.first += extra;
        }
    }

    /** Bytes from `from`, at most `max`; `skipped` counts bytes the reader missed because they were dropped. */
    read(from: number, max: number) {
        const all = Buffer.concat(this.chunks);
        const start = Math.max(from, this.first);
        const skipped = start - from;
        const slice = all.subarray(start - this.first, Math.min(all.length, start - this.first + max));
        // Never end in the middle of a character: stop at the last complete one.
        let end = slice.length;
        if (start - this.first + slice.length < all.length) {
            while (end > 0 && (slice[end - 1]! & 0xc0) === 0x80) end -= 1;
            if (end > 0 && slice[end - 1]! >= 0xc0) end -= 1;
            if (end === 0) end = slice.length;
        }
        return { text: slice.subarray(0, end).toString("utf8"), next: start + end, skipped, more: start + end < this.total };
    }
}

type Entry = {
    info: BackgroundInfo;
    child: ChildProcess;
    output: OutputWindow;
    cursor: number;
    lastOutputAt: number;
    stopping?: Promise<void>;
    closed: Promise<void>;
};

export type BackgroundHooks = {
    /** A command started, or its state changed: the session records it. */
    changed?: (info: BackgroundInfo) => void;
    /** A command wrote output; a host that shows it should look again (called often, so throttle there). */
    activity?: () => void;
};

export class BackgroundCommands {
    private readonly entries = new Map<string, Entry>();
    private exitHook: (() => void) | null = null;

    constructor(
        private readonly options: { extraEnv?: string[]; launch?: CommandLaunch; limit?: number } & BackgroundHooks = {},
    ) {}

    get running() {
        return [...this.entries.values()].filter((entry) => entry.info.state === "running").length;
    }

    list(): BackgroundInfo[] {
        return [...this.entries.values()].map((entry) => ({ ...entry.info }));
    }

    private find(handle: string) {
        const entry = this.entries.get(handle);
        if (!entry) throw new CommandError(`There is no background command ${handle}. Use background_status to see the ones this task started.`);
        return entry;
    }

    /** Starts an approved background command. Returns once it has settled for a moment, so its first output or early failure is visible. */
    async start(plan: CommandPlan, toolCallId: string, display: string, signal?: AbortSignal): Promise<{ info: BackgroundInfo; output: string; more: boolean }> {
        const limit = this.options.limit ?? BACKGROUND_LIMIT;
        if (this.running >= limit) {
            throw new CommandError(`${limit} background commands are already running; stop one with stop_background first.`);
        }
        let child: ChildProcess;
        try {
            child = spawnPlanned(plan, this.options.extraEnv ?? [], this.options.launch);
        } catch (error) {
            throw new CommandError(`The command could not be started: ${(error as Error).message}`);
        }
        const handle = `bg-${randomBytes(3).toString("hex")}`;
        const info: BackgroundInfo = { handle, toolCallId, display, cwd: plan.cwd, startedAt: new Date().toISOString(), state: "running" };
        const output = new OutputWindow();
        let markClosed!: () => void;
        const closed = new Promise<void>((resolve) => { markClosed = resolve; });
        const entry: Entry = { info, child, output, cursor: 0, lastOutputAt: 0, closed };
        this.entries.set(handle, entry);
        this.armExitHook();
        const onData = (chunk: Buffer) => {
            output.push(chunk);
            entry.lastOutputAt = Date.now();
            this.options.activity?.();
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (error) => {
            info.error = error.message;
        });
        child.on("close", (code, sig) => {
            void this.finish(entry, code, sig).finally(markClosed);
        });
        this.options.changed?.({ ...info });
        await this.settle(entry, signal);
        const read = this.take(entry, BACKGROUND_READ_BYTES);
        return { info: { ...info }, output: read.text, more: read.more };
    }

    private async finish(entry: Entry, code: number | null, sig: NodeJS.Signals | null) {
        const { info, child } = entry;
        if (info.state === "running") {
            info.state = "exited";
            info.endReason = info.error && code === null ? "failed_to_start" : "exited";
        }
        info.exitCode = code;
        info.signal = sig;
        info.endedAt = new Date().toISOString();
        // The command ended but may have left processes of its own behind.
        if (entry.stopping === undefined && process.platform !== "win32" && child.pid) {
            try {
                process.kill(-child.pid, 0);
                const left = await killTree(child);
                if (left.residual.length) info.residualProcesses = left.residual;
            } catch {
                // nothing left in the group
            }
        }
        this.options.changed?.({ ...info });
    }

    private async settle(entry: Entry, signal?: AbortSignal) {
        const deadline = Date.now() + SETTLE_MS;
        while (entry.info.state === "running" && Date.now() < deadline && !signal?.aborted) {
            if (entry.lastOutputAt && Date.now() - entry.lastOutputAt >= QUIET_MS) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // An early exit is reported with its exit code, not as a running command.
        if (entry.info.state !== "running") await entry.closed;
    }

    private take(entry: Entry, max: number) {
        const read = entry.output.read(entry.cursor, max);
        entry.cursor = read.next;
        return read;
    }

    /** What was written since the last read of this handle, at most `max` bytes. */
    read(handle: string, max = BACKGROUND_READ_BYTES) {
        const entry = this.find(handle);
        const read = this.take(entry, Math.max(1, Math.min(BACKGROUND_READ_BYTES, max)));
        return { info: { ...entry.info }, output: read.text, more: read.more, skippedBytes: read.skipped };
    }

    /** The newest output of a command without moving its read position: for a host that shows it to the person. */
    peek(handle: string, bytes = 4096): string {
        const entry = this.find(handle);
        const total = entry.output.total;
        return entry.output.read(Math.max(0, total - bytes), bytes).text;
    }

    status(handle?: string): BackgroundInfo[] {
        if (handle) return [{ ...this.find(handle).info }];
        return this.list();
    }

    /** Ends one command's whole process tree. A command that already ended is reported as it is. */
    async stop(handle: string, reason: Extract<BackgroundEndReason, "stopped" | "task_ended"> = "stopped") {
        const entry = this.find(handle);
        await this.end(entry, reason);
        const read = this.take(entry, BACKGROUND_READ_BYTES);
        return { info: { ...entry.info }, output: read.text, more: read.more };
    }

    private async end(entry: Entry, reason: "stopped" | "task_ended") {
        if (entry.info.state !== "running") {
            await entry.closed;
            return;
        }
        entry.stopping ??= (async () => {
            entry.info.state = "stopped";
            entry.info.endReason = reason;
            const left = await killTree(entry.child);
            if (left.residual.length) entry.info.residualProcesses = left.residual;
            await Promise.race([entry.closed, new Promise((resolve) => setTimeout(resolve, 3000))]);
            if (!entry.info.endedAt) {
                entry.info.endedAt = new Date().toISOString();
                this.options.changed?.({ ...entry.info });
            }
        })();
        await entry.stopping;
    }

    /** Ends everything still running: the task ended, was stopped, or the process is going away. */
    async stopAll(reason: "stopped" | "task_ended" = "task_ended") {
        const running = [...this.entries.values()].filter((entry) => entry.info.state === "running");
        await Promise.allSettled(running.map((entry) => this.end(entry, reason)));
        this.disarmExitHook();
    }

    private armExitHook() {
        if (this.exitHook) return;
        // A hook cannot await: the trees are ended with a synchronous kill, so a process exit never leaves a dev server behind.
        this.exitHook = () => {
            for (const entry of this.entries.values()) {
                if (entry.info.state === "running" && entry.child.pid) killTreeSync(entry.child.pid);
            }
        };
        process.once("exit", this.exitHook);
    }

    private disarmExitHook() {
        if (!this.exitHook || this.running > 0) return;
        process.off("exit", this.exitHook);
        this.exitHook = null;
    }
}
