import { posix } from "node:path";
import { BoundedCapture, CommandError, UNSHOWABLE_IN_COMMAND, type CommandInput, type CommandPlan, type CommandResult } from "./commands.js";
import { planEditContent, PatchError, type FileBinding, type PatchEdit, type PlannedEdit } from "./patch.js";
import {
    EXEC_MARKER, EXEC_SCRIPT, FIELDS_MARKER, LIST_SCRIPT, PROBE_SCRIPT, READ_SCRIPT, REMOVE_SCRIPT, RESOLVE_SCRIPT, SEARCH_SCRIPT, WRITE_SCRIPT,
} from "./remote-scripts.js";
import type { SshRunner, SshRunResult } from "./remote-ssh.js";
import {
    classifySshFailure, remoteShellCommand, RemoteError, scriptFailure, targetLabel, type RemoteTarget,
} from "./remote-target.js";
import { PathError, isSecretPath } from "./workspace.js";

/**
 * A folder on another machine, reached by the user's own ssh. The agent runs on this computer; only the file and command
 * operations go over the connection, and every one of them is checked on the machine where the files are (remote-scripts.ts)
 * and again here. The rules are the local ones: nothing outside the project folder, links followed before the check, credential
 * files never read or changed, a write replaces a file in one rename, and a change only goes ahead on the file that was approved.
 */

export type RemoteState = "idle" | "connected" | "lost";

export type RemoteResolved = {
    absolute: string;
    relative: string;
    exists: boolean;
    /** The path as named is itself a link, or goes through one (its real place differs from its name). */
    linked: boolean;
    kind: "file" | "dir" | "other" | "none";
    /** dev:ino:mode of the file, when it is one. */
    ident: string | null;
    /** The nearest existing folder around it, and its dev:ino. */
    folder: string;
    folderIdent: string;
};

export type RemoteProbe = { root: string; home: string; os: string };

const READ_LIMIT = 8 * 1024 * 1024;
const LIST_LIMIT = 20_000;

const UNUSABLE_ANSWER = "The remote machine gave an answer that cannot be used.";

/**
 * The "key=value" lines a script prints after its marker line. Anything else is refused: a line that is not a known key, a key
 * twice, a missing key. A name with a line break in it would otherwise write a line of its own and be read as another answer.
 */
const parseFields = (text: string, required: readonly string[], optional: readonly string[] = []) => {
    const lines = text.split("\n");
    const start = lines.indexOf(FIELDS_MARKER);
    if (start < 0) throw new RemoteError("protocol", UNUSABLE_ANSWER);
    const body = lines.slice(start + 1);
    if (body.at(-1) === "") body.pop();
    const allowed = new Set([...required, ...optional]);
    const out = new Map<string, string>();
    for (const line of body) {
        const at = line.indexOf("=");
        const key = at > 0 ? line.slice(0, at) : "";
        if (!allowed.has(key) || out.has(key)) throw new RemoteError("protocol", UNUSABLE_ANSWER);
        out.set(key, line.slice(at + 1));
    }
    if (required.some((key) => !out.has(key))) throw new RemoteError("protocol", UNUSABLE_ANSWER);
    return out;
};

const CONTROL = /[\u0000-\u001f\u007f]/;

const dirIdent = (ident: string) => ident.split(":").slice(0, 2).join(":");

/** The same checks as planCommand, for a program that is started on the other machine (nothing is looked up on this one). */
export const planRemoteCommand = (input: CommandInput, cwd: string, defaultTimeoutMs: number): CommandPlan => {
    const hasArgv = Array.isArray(input.argv) && input.argv.length > 0;
    const hasCommand = typeof input.command === "string" && input.command.trim().length > 0;
    if (hasArgv === hasCommand) throw new CommandError("Give exactly one of argv (a program and its arguments) or command (a shell line).");
    const requested = input.timeoutSeconds;
    if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) throw new CommandError("timeoutSeconds must be a positive number.");
    const background = input.background === true;
    if (background && requested !== undefined) throw new CommandError("A background command has no time limit: leave out timeoutSeconds, and stop it with stop_background.");
    const timeoutMs = background ? 0 : Math.min(30 * 60_000, requested ? Math.round(requested * 1000) : defaultTimeoutMs);
    const unshowable = (text: string) => typeof text !== "string" || text.includes("\0") || UNSHOWABLE_IN_COMMAND.test(text.replaceAll("\n", ""));
    if (hasArgv) {
        const argv = input.argv!;
        if (argv.some(unshowable)) throw new CommandError("argv must be strings without control, invisible or bidi characters, so the approval shows exactly what runs.");
        const display = argv.map((arg) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ");
        return { mode: "argv", file: argv[0]!, args: argv.slice(1), display, shell: null, cwd, timeoutMs, envNames: [], ...(background ? { background } : {}) };
    }
    const command = input.command!;
    if (unshowable(command)) throw new CommandError("The command contains control, invisible or bidi characters (or CR), so the approval could not show exactly what runs.");
    return { mode: "shell", file: "sh", args: ["-c", command], display: command, shell: "sh", cwd, timeoutMs, envNames: [], ...(background ? { background } : {}) };
};

export type RemoteCommandResult = CommandResult & { lost?: RemoteError };

export class RemoteWorkspace {
    private realRoot: string | null = null;
    private info: RemoteProbe | null = null;
    private lostReason: string | null = null;
    private readonly lostListeners = new Set<(reason: string) => void>();

    constructor(readonly target: RemoteTarget, private readonly runner: SshRunner, private readonly timeouts: { connectMs?: number; operationMs?: number } = {}) {}

    get label() {
        return targetLabel(this.target);
    }

    /** The real project folder on the remote machine (the folder as named until the first connection has resolved it). */
    get root() {
        return this.realRoot ?? this.target.folder;
    }

    get state(): RemoteState {
        return this.lostReason ? "lost" : this.realRoot ? "connected" : "idle";
    }

    get system() {
        return this.info?.os ?? "";
    }

    /** Why nothing may be done on this machine now; undefined while the connection is usable. */
    get blockReason(): string | undefined {
        return this.lostReason
            ? `The connection to ${this.label} was lost (${this.lostReason}). Nothing more is done on that machine until the person reconnects.`
            : undefined;
    }

    /** Called once when the connection is lost. */
    onLost(listener: (reason: string) => void) {
        this.lostListeners.add(listener);
        return () => this.lostListeners.delete(listener);
    }

    markLost(error: RemoteError | string) {
        const reason = typeof error === "string" ? error : error.message;
        if (this.lostReason) return;
        this.lostReason = reason;
        for (const listener of this.lostListeners) {
            try { listener(reason); } catch { /* a listener must not break the others */ }
        }
    }

    /** One ssh run; a failure of ssh itself or of a remote script becomes a RemoteError. An ssh failure ends the connection. */
    private async run(script: string, args: string[], options: { stdin?: Buffer; timeoutMs?: number; signal?: AbortSignal; maxStdoutBytes?: number } = {}): Promise<SshRunResult> {
        if (this.lostReason) throw new RemoteError("connection-lost", this.blockReason!);
        options.signal?.throwIfAborted();
        const result = await this.runner({
            target: this.target, command: remoteShellCommand(script, args), stdin: options.stdin, signal: options.signal,
            timeoutMs: this.timeouts.operationMs ?? options.timeoutMs ?? 30_000, maxStdoutBytes: options.maxStdoutBytes,
        });
        options.signal?.throwIfAborted();
        return this.settle(result, false);
    }

    private settle(result: SshRunResult, connecting: boolean): SshRunResult {
        const sshLevel = result.spawnError !== undefined || result.timedOut || result.exitCode === null || result.exitCode === 255;
        if (sshLevel && !result.truncated) {
            const error = classifySshFailure({ exitCode: result.exitCode, stderr: result.stderr, spawnError: result.spawnError, timedOut: result.timedOut }, this.label);
            if (!connecting) this.markLost(error);
            throw error;
        }
        if (result.exitCode === 0 || result.truncated) return result;
        const scripted = scriptFailure(result.exitCode!, result.stderr, this.label);
        if (scripted) {
            // The size is printed before the "too large" exit; nothing else comes with a refusal.
            throw scripted;
        }
        throw new RemoteError("failed", `The remote command failed (exit ${result.exitCode})${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 300)}` : "."}`);
    }

    /** Looks at the folder on the remote machine. Also what brings a lost connection back. Throws what the person needs to fix. */
    async connect(signal?: AbortSignal): Promise<RemoteProbe> {
        // A connect never marks the workspace lost: the person is already being told, and may fix it and try again.
        this.lostReason = null;
        const result = await this.runnerOnce(PROBE_SCRIPT, [this.target.folder], signal);
        const values = parseFields(result.stdout.toString("utf8"), ["root", "home", "os"]);
        const root = values.get("root")!;
        if (!root.startsWith("/")) throw new RemoteError("protocol", "The remote machine did not describe the folder.");
        if (CONTROL.test(root)) throw new RemoteError("invalid-target", `The folder on ${this.label} has a control character in its real path, which a remote project does not support. Choose another folder.`);
        if (root === "/") throw new RemoteError("folder-too-broad", "The remote root folder is too broad to work in. Choose a project folder.");
        if (isSecretPath(`${root}/`)) throw new RemoteError("folder-too-broad", `${root} is inside a folder that can hold credentials; the CLI does not work there.`);
        const home = values.get("home")!;
        if (home && root === home) throw new RemoteError("folder-too-broad", "The home folder of the remote machine is too broad to work in. Choose a project folder.");
        this.realRoot = root;
        this.lostReason = null;
        this.info = { root, home, os: values.get("os")! };
        return this.info;
    }

    private async runnerOnce(script: string, args: string[], signal?: AbortSignal) {
        signal?.throwIfAborted();
        const result = await this.runner({ target: this.target, command: remoteShellCommand(script, args), signal, timeoutMs: this.timeouts.connectMs ?? 40_000 });
        signal?.throwIfAborted();
        return this.settle(result, true);
    }

    /** Where a path the model named really is, with remote links followed. Throws PathError for a path that may not be used. */
    async resolve(input: string, purpose: "read" | "write", signal?: AbortSignal): Promise<RemoteResolved> {
        if (typeof input !== "string" || input.length === 0) throw new PathError("A path is required.");
        if (/[\u0000-\u001f\u007f]/.test(input)) throw new PathError("A path cannot contain control characters.");
        if (input.includes("\\")) throw new PathError("Use / in paths of a remote project.");
        const root = this.root;
        const lexical = posix.resolve(root, input);
        if (lexical !== root && !lexical.startsWith(`${root}/`)) throw new PathError(`${input} is outside the workspace.`);
        let result: SshRunResult;
        try {
            result = await this.run(RESOLVE_SCRIPT, [root, lexical], { signal });
        } catch (error) {
            if (error instanceof RemoteError && error.code === "outside-root") throw new PathError(`${input} resolves outside the workspace (through a link).`);
            if (error instanceof RemoteError && error.code === "invalid-target") throw new PathError(`${input} goes through a name with a line break, which a remote project does not support.`);
            throw error;
        }
        const values = parseFields(result.stdout.toString("utf8"), ["abs", "exists", "link", "kind", "folder", "fident"], ["ident"]);
        const absolute = values.get("abs")!;
        const folder = values.get("folder")!;
        const folderIdent = values.get("fident")!;
        const kind = values.get("kind")!;
        const unusable = !absolute || !folder || !folderIdent || (absolute !== root && !absolute.startsWith(`${root}/`))
            || !["file", "dir", "other", "none"].includes(kind) || !/^[01]$/.test(values.get("exists")!) || !/^[01]$/.test(values.get("link")!)
            || values.has("ident") !== (kind === "file");
        if (unusable) throw new RemoteError("protocol", "The remote machine gave an answer about a path that cannot be used.");
        if (CONTROL.test(absolute) || CONTROL.test(folder)) throw new PathError(`${input} goes through a name with a control character, which a remote project does not support.`);
        const relative = posix.relative(root, absolute);
        if (isSecretPath(relative)) {
            throw new PathError(`${relative} can hold credentials, so the CLI does not ${purpose === "read" ? "read" : "change"} it. You can open it yourself.`);
        }
        const linked = values.get("link") === "1" || absolute !== lexical;
        if (purpose === "write" && linked) throw new PathError(`${relative || "."} is a link; the CLI does not write through links.`);
        return {
            absolute, relative: relative || ".", exists: values.get("exists") === "1", linked,
            kind: kind as RemoteResolved["kind"], ident: values.get("ident") ?? null, folder, folderIdent,
        };
    }

    /** One file's bytes with the identity it has right now. `absolute` is a path resolve() returned. */
    async readFile(absolute: string, limit = READ_LIMIT, signal?: AbortSignal): Promise<{ bytes: Buffer; ident: string }> {
        let result: SshRunResult;
        try {
            result = await this.run(READ_SCRIPT, [this.root, absolute, String(limit)], { signal, timeoutMs: 60_000, maxStdoutBytes: limit + 4096 });
        } catch (error) {
            if (error instanceof RemoteError && error.code === "too-large") {
                throw new PathError(`${posix.relative(this.root, absolute)} is larger than ${limit} bytes; too large to read. Search it instead.`);
            }
            throw error;
        }
        const body = result.stdout;
        const end = body.indexOf(10);
        const header = end < 0 ? "" : body.subarray(0, end).toString("utf8");
        const match = /^size=(\d+) ident=(\S+)$/.exec(header);
        if (!match) throw new RemoteError("protocol", "The remote machine answered a read in a way that cannot be used.");
        const bytes = body.subarray(end + 1);
        if (bytes.length !== Number(match[1])) throw new RemoteError("changed", "The file changed while it was being read; read it again.");
        return { bytes, ident: match[2]! };
    }

    /** Files under a folder (relative to the project folder), bounded: git's list in a repository, otherwise a walk that skips generated folders. */
    async listFiles(directory: string, limit: number, signal?: AbortSignal): Promise<{ files: string[]; truncated: boolean }> {
        const start = await this.resolve(directory || ".", "read", signal);
        if (start.kind === "none") throw new PathError(`${start.relative} does not exist.`);
        if (start.kind === "file") return { files: [start.relative], truncated: false };
        if (start.kind !== "dir") throw new PathError(`${start.relative} is not a folder.`);
        const result = await this.run(LIST_SCRIPT, [this.root, start.relative, "1"], { signal, timeoutMs: 40_000, maxStdoutBytes: 4 * 1024 * 1024 });
        const seen = new Set<string>();
        const files: string[] = [];
        let truncated = result.truncated;
        for (const raw of result.stdout.toString("utf8").split("\0")) {
            const name = raw.replace(/^\.\//, "");
            // A name with a control character or a backslash cannot be shown or handed to a tool as it is.
            if (!name || seen.has(name) || /[\u0000-\u001f\u007f\\]/.test(name) || isSecretPath(name)) continue;
            seen.add(name);
            if (files.length >= limit) { truncated = true; break; }
            files.push(name);
        }
        return { files: files.sort(), truncated };
    }

    /** Literal or regular-expression search over the listed files, run on the remote machine with grep. */
    async searchText(input: { pattern: string; path?: string; regex?: boolean; caseSensitive?: boolean; maxResults: number }, signal?: AbortSignal) {
        if (input.pattern.includes("\0") || input.pattern.includes("\n") || !input.pattern) throw new PathError("A search pattern is one line of text.");
        const listed = await this.listFiles(input.path ?? ".", LIST_LIMIT, signal);
        if (!listed.files.length) return { matches: [] as string[], truncated: listed.truncated };
        const result = await this.run(SEARCH_SCRIPT, [this.root, input.regex ? "E" : "F", input.caseSensitive ? "s" : "i", input.pattern], {
            signal, timeoutMs: 40_000, maxStdoutBytes: 2 * 1024 * 1024, stdin: Buffer.from(`${listed.files.join("\0")}\0`, "utf8"),
        });
        const matches: string[] = [];
        let truncated = listed.truncated || result.truncated;
        for (const line of result.stdout.toString("utf8").split("\n")) {
            const at = line.indexOf("\0");
            if (at <= 0) continue;
            const file = line.slice(0, at).replace(/^\.\//, "");
            if (isSecretPath(file)) continue;
            if (matches.length >= input.maxResults) { truncated = true; break; }
            matches.push(`${file}:${line.slice(at + 1).slice(0, 300)}`);
        }
        return { matches, truncated };
    }

    /** What the approval shows and is bound to: every edit read from the remote files as they are now, nothing written. */
    async planPatch(edits: PatchEdit[], signal?: AbortSignal): Promise<PlannedEdit[]> {
        if (!Array.isArray(edits) || edits.length === 0) throw new PatchError("A patch needs at least one edit.");
        if (edits.length > 50) throw new PatchError("At most 50 files per patch.");
        const seen = new Set<string>();
        const planned: PlannedEdit[] = [];
        for (const edit of edits) {
            const resolved = await this.resolve(edit.path, "write", signal);
            if (seen.has(resolved.absolute)) throw new PatchError(`${resolved.relative} appears twice in one patch; combine the edits.`);
            seen.add(resolved.absolute);
            if (resolved.exists && resolved.kind !== "file") throw new PatchError(`${resolved.relative} is not a regular file.`);
            const binding: FileBinding = { file: resolved.ident, folder: resolved.folder, directory: dirIdent(resolved.folderIdent) };
            let bytes: Buffer | null = null;
            if (resolved.exists) {
                const read = await this.readFile(resolved.absolute, READ_LIMIT, signal);
                if (read.ident !== resolved.ident) throw new PatchError(`${resolved.relative} changed while the patch was being prepared. Read it again.`);
                bytes = read.bytes;
            }
            planned.push(planEditContent(edit, resolved.relative, resolved.absolute, bytes, binding));
        }
        return planned;
    }

    /** Writes one planned create or update on the remote machine. Returns what is there now. */
    async writeFile(edit: PlannedEdit, signal?: AbortSignal): Promise<{ ident: string; folderIdent: string }> {
        if (edit.action === "delete" || !edit.afterBytes) throw new PatchError("Nothing to write.");
        return this.writeBytes(edit.absolute, edit.afterBytes, {
            create: edit.action === "create", expect: edit.binding.file, folder: edit.binding.folder, directory: edit.binding.directory,
        }, signal);
    }

    /**
     * The content goes to a temporary file in the same folder, is checked for length, and replaces the target with one rename, so
     * a reader (and a connection that drops half way) sees the old file or the new one. An update goes ahead only if the file
     * still has the identity `expect`; a create only if nothing is there. `mode` (octal digits) sets the permissions afterwards.
     */
    async writeBytes(absolute: string, bytes: Buffer, bound: { create: boolean; expect: string | null; folder: string; directory: string; mode?: string },
        signal?: AbortSignal): Promise<{ ident: string; folderIdent: string }> {
        if (bound.mode !== undefined && !/^[0-7]{3,4}$/.test(bound.mode)) throw new PatchError("The file mode is not usable.");
        const result = await this.run(WRITE_SCRIPT, [
            this.root, absolute, bound.expect ?? "-", bound.create ? "1" : "0", String(bytes.length), bound.folder, bound.directory, bound.mode ?? "",
        ], { stdin: bytes, signal, timeoutMs: 60_000 + Math.ceil(bytes.length / 20_000) });
        const values = parseFields(result.stdout.toString("utf8"), ["ident", "fident"]);
        const ident = values.get("ident");
        const folderIdent = values.get("fident");
        if (!ident || !folderIdent) throw new RemoteError("protocol", "The remote machine did not confirm the write.");
        return { ident, folderIdent: dirIdent(folderIdent) };
    }

    async removeFile(edit: PlannedEdit, signal?: AbortSignal) {
        await this.removeIdentified(edit.absolute, edit.binding.file, signal);
    }

    /** Removes a file only if it still has the identity it was approved with. */
    async removeIdentified(absolute: string, ident: string | null, signal?: AbortSignal) {
        if (!ident) throw new PatchError(`${posix.relative(this.root, absolute)} does not exist.`);
        await this.run(REMOVE_SCRIPT, [this.root, absolute, ident], { signal });
    }

    /** The first of AGENTS.md and CLAUDE.md the folder has, bounded; null when there is none (or the machine cannot be reached now). */
    async readInstructions(signal?: AbortSignal): Promise<{ text: string; truncated: boolean } | null> {
        const pieces: Array<{ name: string; text: string; truncated: boolean }> = [];
        for (const name of ["AGENTS.md", "CLAUDE.md"]) {
            try {
                const resolved = await this.resolve(name, "read", signal);
                if (resolved.kind !== "file") continue;
                const { bytes } = await this.readFile(resolved.absolute, 256 * 1024, signal);
                const text = bytes.toString("utf8").replace(/^﻿/, "");
                if (text.trim()) pieces.push({ name, text: text.slice(0, 32_000), truncated: text.length > 32_000 });
            } catch (error) {
                if (signal?.aborted || (error instanceof RemoteError && error.code === "connection-lost")) return null;
            }
        }
        if (!pieces.length) return null;
        if (pieces.length === 1 && pieces[0]!.name === "AGENTS.md") return { text: pieces[0]!.text, truncated: pieces[0]!.truncated };
        return { text: pieces.map((piece) => `--- ${piece.name} ---\n${piece.text}`).join("\n"), truncated: pieces.some((piece) => piece.truncated) };
    }

    /**
     * Runs an approved command on the remote machine. The command's input is closed; the output is bounded like a local command's.
     * When the connection goes away (or the task is stopped) the machine ends the command by itself; a dropped connection is
     * reported in `lost` and ends the use of the machine until the person reconnects.
     */
    async exec(plan: CommandPlan, signal: AbortSignal, onOutput?: (stream: "stdout" | "stderr", text: string) => void,
        hooks: { onStarted?: () => void } = {}): Promise<RemoteCommandResult> {
        if (this.lostReason) throw new RemoteError("connection-lost", this.blockReason!);
        const started = Date.now();
        const stdout = new BoundedCapture();
        const stderr = new BoundedCapture();
        let head: Buffer | null = Buffer.alloc(0);
        let begun = false;
        const emit = (chunk: Buffer) => {
            stdout.push(chunk);
            onOutput?.("stdout", chunk.toString("utf8"));
        };
        const args = [this.root, plan.cwd, plan.mode === "shell" ? "shell" : "argv", ...(plan.mode === "shell" ? [plan.display] : [plan.file, ...plan.args])];
        const result = await this.runner({
            target: this.target, command: remoteShellCommand(EXEC_SCRIPT, args), holdStdin: true, signal, timeoutMs: plan.timeoutMs,
            onStdout: (chunk) => {
                if (begun) { emit(chunk); return; }
                if (head === null) return;
                head = Buffer.concat([head, chunk]);
                const end = head.indexOf(10);
                if (end < 0) {
                    if (head.length > 64) head = null;
                    return;
                }
                if (head.subarray(0, end).toString("utf8") === EXEC_MARKER) {
                    begun = true;
                    hooks.onStarted?.();
                    const rest = head.subarray(end + 1);
                    head = null;
                    if (rest.length) emit(rest);
                } else head = null;
            },
            onStderr: (chunk) => {
                stderr.push(chunk);
                onOutput?.("stderr", chunk.toString("utf8"));
            },
        });
        const base = {
            signal: result.signal, timedOut: result.timedOut && begun, cancelled: result.aborted, durationMs: Date.now() - started,
            stdout: stdout.text(), stderr: stderr.text(), stdoutOmittedBytes: stdout.omitted, stderrOmittedBytes: stderr.omitted,
            // The remote process tree is the remote machine's to end; it cannot be listed from here.
            residualProcesses: [] as number[], processTreeChecked: false,
        };
        if (!begun) {
            // Never started: ssh failed, or the script refused the folder.
            if (result.aborted) return { ...base, exitCode: null, cancelled: true };
            if (result.exitCode !== null && result.exitCode >= 40 && result.exitCode <= 48) {
                const refused = scriptFailure(result.exitCode, result.stderr, this.label);
                if (refused) throw refused;
            }
            const error = classifySshFailure({ exitCode: result.exitCode, stderr: result.stderr, spawnError: result.spawnError, timedOut: result.timedOut }, this.label);
            this.markLost(error);
            throw error;
        }
        const text = stderr.text();
        if (!result.aborted && !result.timedOut && (result.exitCode === 255 || result.exitCode === null)
            && /Connection (?:reset|closed)|Broken pipe|client_loop|Timeout, server|packet_write|Connection to .* closed/i.test(text)) {
            const lost = classifySshFailure({ exitCode: 255, stderr: text }, this.label);
            this.markLost(lost);
            return { ...base, exitCode: null, lost };
        }
        return { ...base, exitCode: result.exitCode };
    }
}
