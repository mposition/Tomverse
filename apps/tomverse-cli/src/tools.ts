import { setImmediate as yieldTurn } from "node:timers/promises";
import { readProcess } from "./readprocess.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { commandEnv, planCommand, runCommand, CommandError, type CommandLaunch, type CommandPlan } from "./commands.js";
import { BACKGROUND_READ_BYTES, type BackgroundCommands, type BackgroundInfo } from "./background.js";
import { assertBoundFile, currentDigest, pathIdentity, planPatch, PatchError, removeFile, writeFileReplacing, type PatchEdit, type PlannedEdit } from "./patch.js";
import { canonicalDigest, JournalError, sha256, type Journal } from "./session.js";
import { PathError, type Workspace } from "./workspace.js";

/**
 * The tools the model can call. list_files, search_text and read_file only
 * read inside the workspace and run without approval. apply_patch and
 * run_command change things: they exist only outside --read-only, the SDK
 * stops for the user's approval before each call, and `execute` itself checks
 * -- right before acting -- that this exact call was approved for this exact
 * input and file state, and that it has not already been run.
 */

export const READ_TOOLS = ["list_files", "search_text", "read_file"] as const;
export const WRITE_TOOLS = ["apply_patch", "run_command"] as const;

const READ_LINE_LIMIT = 2000;
const SEARCH_FILE_BYTES = 1024 * 1024;

export type ToolContext = {
    /** Bytes one read_file call returns at most, sized to the model's window. */
    readByteLimit: number;
    workspace: Workspace;
    journal: Journal;
    commandTimeoutMs: number;
    commandEnv: string[];
    launchCommand?: CommandLaunch;
    /** The commands this task keeps running in the background; without it the background tools do not exist. */
    background?: BackgroundCommands;
    signal: () => AbortSignal;
    assertAllowed?: () => void;
    effectBlockReason?: () => string | undefined;
    redactText?: (text: string) => string;
    /** Synchronous, idempotent guard: before backup and again immediately before disk mutation. */
    beforeWrite?: (edit: PlannedEdit, toolCallId: string) => void;
    trackExecution?: (execution: Promise<unknown>) => void;
    beforeCommand?: (plan: CommandPlan, toolCallId: string) => void;
    onActivity: (line: string) => void;
    onCommandOutput: (stream: "stdout" | "stderr", text: string) => void;
};

/** What the model is told about a background command's end. */
const backgroundExit = (info: BackgroundInfo) => info.state === "running" ? {} : {
    exitCode: info.exitCode ?? null,
    ...(info.signal ? { signal: info.signal } : {}),
    ...(info.endReason ? { endReason: info.endReason } : {}),
    ...(info.residualProcesses?.length ? { residualProcesses: info.residualProcesses } : {}),
};

const toolError = (error: unknown) => ({
    status: "error" as const,
    error: error instanceof PathError || error instanceof PatchError || error instanceof CommandError ? error.message : `Failed: ${(error as Error).message}`,
});

export const patchSchema = z.object({
    edits: z
        .array(
            z.object({
                path: z.string().describe("File path relative to the workspace root."),
                action: z.enum(["create", "update", "delete"]),
                content: z.string().optional().describe("Full content, for create."),
                replacements: z
                    .array(z.object({ old: z.string().describe("Exact existing text; must occur exactly once."), new: z.string() }))
                    .optional()
                    .describe("For update: exact replacements applied in order."),
            })
        )
        .min(1),
    explanation: z.string().optional().describe("One line on why, shown to the user."),
});

export const commandSchema = z.object({
    argv: z.array(z.string()).optional().describe("Program and arguments, run without a shell. Preferred."),
    command: z.string().optional().describe("A shell line, for pipes, globs or Windows npm/npx (.cmd). Runs in PowerShell on Windows, bash/zsh/sh elsewhere."),
    cwd: z.string().optional().describe("Folder relative to the workspace root."),
    timeoutSeconds: z.number().optional(),
    background: z.boolean().optional().describe("Keep the command running after this call returns, for a dev server or a watcher. It has no time limit and the user's approval says it runs in the background. You get a handle: read what it printed with read_background_output, stop it with stop_background. It is ended when this task ends."),
});

export type PatchInput = z.infer<typeof patchSchema>;
export type CommandToolInput = z.infer<typeof commandSchema>;

/** The plan the approval screen shows and the approval is bound to. */
export const planPatchCall = (ctx: Pick<ToolContext, "workspace">, input: PatchInput) => planPatch(ctx.workspace, input.edits as PatchEdit[]);

export const planCommandCall = (ctx: Pick<ToolContext, "workspace" | "commandTimeoutMs" | "commandEnv">, input: CommandToolInput): CommandPlan => {
    const cwd = ctx.workspace.resolve(input.cwd ?? ".", "read");
    if (!existsSync(cwd.absolute) || !statSync(cwd.absolute).isDirectory()) throw new CommandError(`${cwd.relative} is not a folder.`);
    return planCommand(input, cwd.absolute, ctx.commandTimeoutMs, ctx.commandEnv);
};

/**
 * The gate in front of every write. Returns an error result (and does
 * nothing) unless the user approved this tool call with this input, and the
 * call has not started before. Records the start durably before returning ok.
 */
const gate = (ctx: ToolContext, toolName: string, toolCallId: string, input: unknown) => {
    if (ctx.journal.broken) return { ok: false as const, result: { status: "error", error: "The session journal cannot be written; nothing was run." } };
    const digest = canonicalDigest(input);
    const previous = ctx.journal.state.tools.find((t) => t.toolCallId === toolCallId);
    if (previous) {
        // Never run twice. A completed call gives back what it returned; one
        // that started and never finished has an unknown outcome.
        return {
            ok: false as const,
            result:
                previous.state === "completed" && previous.output !== undefined
                    ? previous.output
                    : { status: "unknown", error: `This ${toolName} call already started once and its outcome is unknown; it was not run again. Check the files or ask the user.` },
        };
    }
    const blocked = ctx.effectBlockReason?.();
    if (blocked) return { ok: false as const, result: { status: "denied", error: blocked } };
    // The latest decision for this call counts; an older approval never outlives a later denial.
    const approval = ctx.journal.state.approvals.findLast((a) => a.toolCallId === toolCallId && a.toolName === toolName);
    if (!approval || approval.decision !== "approved" || approval.inputDigest !== digest) {
        return { ok: false as const, result: { status: "denied", error: "Not approved by the user for this exact input." } };
    }
    return { ok: true as const, digest, approval };
};

const startTool = (ctx: ToolContext, toolName: string, toolCallId: string, digest: string, plan?: CommandPlan) => {
    const redact = (text: string) => ctx.redactText?.(text) ?? text;
    const command = plan ? { mode: plan.mode, file: redact(plan.file), args: plan.args.map(redact), cwd: redact(plan.cwd),
        envNames: plan.envNames, timeoutMs: plan.timeoutMs } : undefined;
    ctx.journal.state.tools.push({ toolCallId, toolName, inputDigest: digest, state: "started", startedAt: new Date().toISOString(), command });
    ctx.journal.commit();
};

const endTool = (ctx: ToolContext, toolCallId: string, state: "completed" | "failed", output: unknown) => {
    const record = ctx.journal.state.tools.find((t) => t.toolCallId === toolCallId);
    if (record) {
        record.state = state;
        record.endedAt = new Date().toISOString();
        record.output = output;
    }
    ctx.journal.commit();
    return output;
};

export const readFileTool = (ctx: Pick<ToolContext, "workspace" | "readByteLimit" | "redactText">,
    input: { path: string; startLine?: number; endLine?: number }) => {
    const resolved = ctx.workspace.resolve(input.path, "read");
    if (!resolved.exists) return { status: "error", error: `${resolved.relative} does not exist.` };
    const stat = statSync(resolved.absolute);
    if (!stat.isFile()) return { status: "error", error: `${resolved.relative} is not a file.` };
    if (stat.size > 8 * 1024 * 1024) return { status: "error", error: `${resolved.relative} is ${stat.size} bytes; too large to read. Search it instead.` };
    const bytes = readFileSync(resolved.absolute);
    if (bytes.subarray(0, 8192).includes(0)) return { status: "error", error: `${resolved.relative} looks binary.` };
    const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, Math.floor(input.startLine ?? 1));
    let end = Math.min(lines.length, Math.floor(input.endLine ?? start + READ_LINE_LIMIT - 1), start + READ_LINE_LIMIT - 1);
    let body = lines.slice(start - 1, end).join("\n");
    let truncated = end < lines.length;
    if (Buffer.byteLength(body) > ctx.readByteLimit) {
        body = Buffer.from(body).subarray(0, ctx.readByteLimit).toString("utf8");
        end = start + body.split("\n").length - 1;
        truncated = true;
    }
    return {
        status: "ok",
        path: resolved.relative,
        totalLines: lines.length,
        startLine: start,
        endLine: end,
        truncated,
        lineEndings: text.includes("\r\n") ? "crlf" : "lf",
        sha256: sha256(bytes),
        text: ctx.redactText?.(body) ?? body,
    };
};

const NEWLINE = "\n";
const BACKSLASH = "\\";
const LEADING_DOT_SLASH = /^\.[\\/]/;
const TRAILING_EOL = /\r?\n$/;

const searchTool = async (ctx: ToolContext, input: { pattern: string; path?: string; regex?: boolean; caseSensitive?: boolean; maxResults?: number }) => {
    const where = ctx.workspace.resolve(input.path ?? ".", "read");
    const max = Math.min(500, Math.max(1, input.maxResults ?? 100));
    const matches: string[] = [];
    let truncated = false;
    // One list for both engines: the workspace listing, which already leaves out
    // credential files, the CLI home and links out of the folder. Nothing else is
    // opened -- ripgrep is given exactly these files, never a folder to walk.
    const listed = await ctx.workspace.listFilesAsync(where.relative, 20_000, ctx.signal());
    let missingRg = false;
    {
        // --json gives each match's path and line as separate fields, so no
        // character in a file name can make one path look like another.
        const base = ["--no-config", "--json", "--no-ignore", "--hidden", "--max-columns", "300", "--max-columns-preview", "--max-filesize", "1M"];
        if (!input.regex) base.push("--fixed-strings");
        if (!input.caseSensitive) base.push("--ignore-case");
        base.push("-e", input.pattern, "--");
        // Batches that fit a Windows command line.
        const batches: string[][] = [];
        let batch: string[] = [];
        let length = 0;
        for (const file of listed.files) {
            if (batch.length && length + file.length + 3 > 24_000) {
                batches.push(batch);
                batch = [];
                length = 0;
            }
            batch.push(file);
            length += file.length + 3;
        }
        if (batch.length) batches.push(batch);
        const started = Date.now();
        outer: for (const files of batches) {
            const remaining = 30_000 - (Date.now() - started);
            if (remaining <= 0) throw new Error("Search time limit reached.");
            ctx.assertAllowed?.();
            const result = await readProcess("rg", [...base, ...files], { cwd: ctx.workspace.root, env: commandEnv(), signal: ctx.signal(), timeoutMs: remaining });
            if (result.missing) { missingRg = true; break; }
            if (result.code !== 0 && result.code !== 1) return { status: "error", error: (result.stderr || "search failed").slice(0, 500) };
            for (const line of (result.stdout ?? "").split(NEWLINE)) {
                if (!line) continue;
                let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
                try {
                    event = JSON.parse(line);
                } catch {
                    continue;
                }
                if (event.type !== "match") continue;
                // A path or line that is not valid UTF-8 comes as bytes: left out.
                const rawPath = event.data?.path?.text;
                const text = event.data?.lines?.text;
                if (typeof rawPath !== "string" || typeof text !== "string") continue;
                const file = rawPath.replace(LEADING_DOT_SLASH, "").replaceAll(BACKSLASH, "/");
                if (matches.length >= max) {
                    truncated = true;
                    break outer;
                }
                matches.push(`${file}:${event.data?.line_number ?? "?"}:${text.replace(TRAILING_EOL, "")}`);
            }
        }
        if (!missingRg) return { status: "ok", engine: "ripgrep", matches, truncated: truncated || listed.truncated };
    }
    if (input.regex) return { status: "unsupported", error: "Regex search requires ripgrep (rg). Install rg or use a literal search." };
    const pattern = input.caseSensitive ? input.pattern : input.pattern.toLowerCase();
    // Literal matching only; yielding between bounded files makes Stop responsive.
    const started = Date.now();
    outer: for (const file of listed.files) {
        await yieldTurn();
        ctx.signal().throwIfAborted();
        ctx.assertAllowed?.();
        if (Date.now() - started > 30_000) {
            truncated = true;
            break;
        }
        const abs = ctx.workspace.resolve(file, "read").absolute;
        let bytes: Buffer;
        try {
            if (statSync(abs).size > SEARCH_FILE_BYTES) continue;
            bytes = readFileSync(abs);
        } catch {
            continue;
        }
        if (bytes.subarray(0, 8192).includes(0)) continue;
        const lines = bytes.toString("utf8").split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
            const bounded = line.slice(0, 2000);
            if (!(input.caseSensitive ? bounded : bounded.toLowerCase()).includes(pattern)) continue;
            if (matches.length >= max) {
                truncated = true;
                break outer;
            }
            matches.push(`${file}:${index + 1}:${line.slice(0, 300)}`);
        }
    }
    return { status: "ok", engine: "builtin", matches, truncated: truncated || listed.truncated };
};

export const applyPlannedPatch = (ctx: ToolContext, toolCallId: string, planned: PlannedEdit[]) => {
    const results: Array<{ path: string; action: string; status: "applied" | "failed" | "not_attempted" | "unconfirmed"; error?: string }> = [];
    let failed = false;
    for (const edit of planned) {
        if (failed) {
            results.push({ path: edit.path, action: edit.action, status: "not_attempted" });
            continue;
        }
        const changeId = `c${ctx.journal.state.changes.length + 1}-${randomBytes(3).toString("hex")}`;
        let wrote = false;
        const guard = () => {
            ctx.assertAllowed?.();
            ctx.signal().throwIfAborted();
            assertBoundFile(ctx.workspace, edit.path, edit.absolute, edit.binding, edit.preimage);
        };
        try {
            ctx.beforeWrite?.(edit, toolCallId);
            guard();
            const before = edit.preimage ? readFileSync(edit.absolute) : null;
            if (before && sha256(before) !== edit.preimage) throw new PatchError(`${edit.path} changed while its backup was being read.`);
            ctx.journal.state.changes.push({
                changeId,
                toolCallId,
                path: edit.path,
                kind: edit.action,
                preimage: { sha256: edit.preimage, backup: before ? ctx.journal.saveBackup(changeId, before) : null,
                    identity: edit.binding.file, ...(before ? { mode: statSync(edit.absolute).mode & 0o7777 } : {}) },
                postimage: { sha256: edit.postimage, backup: edit.afterBytes ? ctx.journal.saveBackup(changeId, edit.afterBytes, "post") : null },
                state: "writing",
            });
            ctx.journal.commit();
            ctx.beforeWrite?.(edit, toolCallId);
            if (edit.action === "delete") {
                guard();
                removeFile(edit.absolute);
            } else {
                writeFileReplacing(edit.absolute, edit.afterBytes!, undefined, guard, edit.action === "create");
            }
            wrote = true;
            const record = ctx.journal.state.changes.find((c) => c.changeId === changeId)!;
            record.directory = pathIdentity(dirname(edit.absolute), "directory") ?? undefined;
            record.postimage.identity = pathIdentity(edit.absolute, "file");
            record.state = currentDigest(edit.absolute) === edit.postimage ? "applied" : "writing";
            record.appliedAt = new Date().toISOString();
            ctx.journal.commit();
            if (record.state !== "applied") throw new PatchError(`${edit.path} does not hold the written content afterwards.`);
            results.push({ path: edit.path, action: edit.action, status: "applied" });
        } catch (error) {
            failed = true;
            const record = ctx.journal.state.changes.find((c) => c.changeId === changeId);
            if (record && record.state === "writing") {
                record.state = wrote ? "writing" : "failed";
                try {
                    ctx.journal.commit();
                } catch {
                    // reported by the caller's next commit
                }
            }
            if (error instanceof JournalError) throw error;
            const status = record?.state === "applied" ? "applied" : wrote ? "unconfirmed" : "failed";
            results.push({ path: edit.path, action: edit.action, status, error: (error as Error).message });
        }
    }
    const applied = results.filter((r) => r.status === "applied").length;
    return {
        status: failed ? (applied ? "partial" : "error") : "ok",
        files: results,
        note: failed ? "Files are changed one at a time. Check the outcome of every file, especially any marked unconfirmed, before retrying." : undefined,
    };
};

export const createTools = (ctx: ToolContext, readOnly: boolean): ToolSet => {
    const tools: ToolSet = {
        list_files: tool({
            description: "List files under a folder of the workspace (bounded; skips generated folders and credential files).",
            inputSchema: z.object({ path: z.string().optional(), limit: z.number().optional() }),
            execute: async (input) => {
                try {
                    ctx.assertAllowed?.();
                    ctx.signal().throwIfAborted();
                    ctx.onActivity(`list_files ${input.path ?? "."}`);
                    const listed = await ctx.workspace.listFilesAsync(input.path ?? ".", Math.min(2000, Math.max(1, input.limit ?? 500)), ctx.signal());
                    return { status: "ok", ...listed };
                } catch (error) {
                    return toolError(error);
                }
            },
        }),
        search_text: tool({
            description: "Search file contents in the workspace. Literal by default; regex: true for a regular expression.",
            inputSchema: z.object({ pattern: z.string(), path: z.string().optional(), regex: z.boolean().optional(), caseSensitive: z.boolean().optional(), maxResults: z.number().optional() }),
            execute: async (input) => {
                try {
                    ctx.assertAllowed?.();
                    ctx.signal().throwIfAborted();
                    ctx.onActivity(`search_text ${JSON.stringify(input.pattern)}${input.path ? ` in ${input.path}` : ""}`);
                    const result = await searchTool(ctx, input);
                    if (result.matches && ctx.redactText) result.matches = result.matches.map(ctx.redactText);
                    return result;
                } catch (error) {
                    return toolError(error);
                }
            },
        }),
        read_file: tool({
            description: `Read a text file of the workspace, up to ${READ_LINE_LIMIT} lines per call; use startLine/endLine for more.`,
            inputSchema: z.object({ path: z.string(), startLine: z.number().optional(), endLine: z.number().optional() }),
            execute: async (input) => {
                try {
                    ctx.assertAllowed?.();
                    ctx.signal().throwIfAborted();
                    ctx.onActivity(`read_file ${input.path}${input.startLine ? `:${input.startLine}-${input.endLine ?? ""}` : ""}`);
                    return readFileTool(ctx, input);
                } catch (error) {
                    return toolError(error);
                }
            },
        }),
    };
    if (readOnly) return tools;
    tools.apply_patch = tool({
        description:
            "Create, update (exact text replacements) or delete files. The user sees the diff and must approve it. Read a file before updating it; each old text must occur exactly once.",
        inputSchema: patchSchema,
        execute: async (input, { toolCallId }) => {
            const decision = gate(ctx, "apply_patch", toolCallId, input);
            if (!decision.ok) return decision.result;
            let planned: PlannedEdit[];
            try {
                planned = planPatchCall(ctx, input);
            } catch (error) {
                return toolError(error);
            }
            const bound = decision.approval.binding.files ?? [];
            const drift = planned.filter((p) => {
                const approved = bound.find((b) => b.path === p.path);
                return !approved || approved.preimage !== p.preimage || (approved.disk && (
                    approved.disk.file !== p.binding.file || approved.disk.folder !== p.binding.folder ||
                    approved.disk.directory !== p.binding.directory
                ));
            });
            if (drift.length || bound.length !== planned.length) {
                return { status: "error", error: `Changed since it was approved, so nothing was written: ${drift.map((d) => d.path).join(", ") || "file set"}. Read the files again and propose a new patch.` };
            }
            startTool(ctx, "apply_patch", toolCallId, decision.digest);
            const result = applyPlannedPatch(ctx, toolCallId, planned);
            return endTool(ctx, toolCallId, result.status === "ok" ? "completed" : "failed", result);
        },
    });
    tools.run_command = tool({
        description:
            "Run one command in the workspace after the user approves it. It runs with the user's permissions (not sandboxed). Prefer argv; use command for shell syntax or Windows npm/npx. stdin is closed; output is bounded.",
        inputSchema: commandSchema,
        execute: async (input, { toolCallId }) => {
            const decision = gate(ctx, "run_command", toolCallId, input);
            if (!decision.ok) return decision.result;
            let plan: CommandPlan;
            try {
                plan = planCommandCall(ctx, input);
            } catch (error) {
                return toolError(error);
            }
            if (decision.approval.binding.cwd !== plan.cwd) {
                return { status: "error", error: "The working folder resolves differently than when it was approved; not run." };
            }
            if ((decision.approval.binding.background ?? false) !== (plan.background ?? false)) {
                return { status: "error", error: "The approval was for a different kind of run (background or not); not run." };
            }
            // The program the approval showed (resolved on PATH on Windows) is the one that runs.
            if (decision.approval.binding.program !== undefined && decision.approval.binding.program !== plan.file) {
                return { status: "error", error: `The program now resolves to ${plan.file}, not the ${decision.approval.binding.program} that was approved; not run.` };
            }
            try { ctx.assertAllowed?.(); ctx.signal().throwIfAborted(); ctx.beforeCommand?.(plan, toolCallId); } catch (error) { return toolError(error); }
            const envNames = Object.keys(commandEnv(ctx.commandEnv)).sort();
            const approvedNames = decision.approval.binding.envNames ?? plan.envNames;
            if (envNames.length !== approvedNames.length || envNames.some((name, index) => name !== approvedNames[index])) {
                return { status: "error", error: "The command environment changed after approval. Review the command again." };
            }
            plan.envNames = envNames;
            startTool(ctx, "run_command", toolCallId, decision.digest, plan);
            if (plan.background) {
                if (!ctx.background) return endTool(ctx, toolCallId, "failed", { status: "error", error: "Background commands are not available here." });
                ctx.onActivity(`run in the background ${plan.display}`);
                try {
                    const started = await ctx.background.start(plan, toolCallId, ctx.redactText?.(plan.display) ?? plan.display, ctx.signal());
                    return endTool(ctx, toolCallId, "completed", {
                        status: "started",
                        background: true,
                        handle: started.info.handle,
                        state: started.info.state,
                        ...backgroundExit(started.info),
                        output: ctx.redactText?.(started.output) ?? started.output,
                        ...(started.more ? { moreOutput: true } : {}),
                        note: started.info.state === "running"
                            ? "Running in the background until this task ends. Read new output with read_background_output, stop it with stop_background."
                            : "It already ended; see exitCode.",
                    });
                } catch (error) {
                    return endTool(ctx, toolCallId, "failed", toolError(error));
                }
            }
            ctx.onActivity(`run ${plan.display}`);
            const execution = runCommand(plan, ctx.signal(), ctx.onCommandOutput, ctx.commandEnv, ctx.launchCommand).then((result) => {
                const output = {
                    status: result.spawnError ? "error" : result.cancelled ? "cancelled" : result.timedOut ? "timeout" : "ok",
                    exitCode: result.exitCode,
                    signal: result.signal,
                    durationMs: result.durationMs,
                    stdout: ctx.redactText?.(result.stdout) ?? result.stdout,
                    stderr: ctx.redactText?.(result.stderr) ?? result.stderr,
                    ...(result.stdoutOmittedBytes || result.stderrOmittedBytes ? { omittedBytes: { stdout: result.stdoutOmittedBytes, stderr: result.stderrOmittedBytes } } : {}),
                    ...(result.residualProcesses.length ? { residualProcesses: result.residualProcesses } : {}),
                    ...(result.processTreeChecked ? {} : { processTreeChecked: false, note: "The command's child processes could not be listed; some may still be running." }),
                    ...(result.spawnError ? { error: result.spawnError } : {}),
                };
                return endTool(ctx, toolCallId, result.spawnError ? "failed" : "completed", output);
            });
            ctx.trackExecution?.(execution);
            return execution;
        },
    });
    if (ctx.background) {
        const background = ctx.background;
        const clean = (text: string) => ctx.redactText?.(text) ?? text;
        const guarded = <T>(run: () => T | Promise<T>) => async () => {
            try {
                ctx.assertAllowed?.();
                ctx.signal().throwIfAborted();
                return await run();
            } catch (error) {
                return toolError(error);
            }
        };
        tools.read_background_output = tool({
            description: "Read what a background command printed since the last time you read it (stdout and stderr together, bounded). Needs no approval.",
            inputSchema: z.object({ handle: z.string(), maxBytes: z.number().optional() }),
            execute: (input) => guarded(() => {
                ctx.onActivity(`read_background_output ${input.handle}`);
                const read = background.read(input.handle, input.maxBytes ?? BACKGROUND_READ_BYTES);
                return {
                    status: "ok",
                    handle: read.info.handle,
                    state: read.info.state,
                    ...backgroundExit(read.info),
                    output: clean(read.output),
                    ...(read.more ? { moreOutput: true } : {}),
                    ...(read.skippedBytes ? { skippedBytes: read.skippedBytes, note: "Older output was dropped to keep memory bounded." } : {}),
                };
            })(),
        });
        tools.background_status = tool({
            description: "Whether the background commands this task started are still running. Without a handle, lists all of them.",
            inputSchema: z.object({ handle: z.string().optional() }),
            execute: (input) => guarded(() => {
                ctx.onActivity(`background_status${input.handle ? ` ${input.handle}` : ""}`);
                return {
                    status: "ok",
                    commands: background.status(input.handle).map((info) => ({
                        handle: info.handle, state: info.state, command: info.display, startedAt: info.startedAt, ...backgroundExit(info),
                    })),
                };
            })(),
        });
        tools.stop_background = tool({
            description: "Stop a background command this task started, with all the processes it started. Needs no approval because only your own handles exist.",
            inputSchema: z.object({ handle: z.string() }),
            execute: (input) => guarded(async () => {
                ctx.onActivity(`stop_background ${input.handle}`);
                const stopped = await background.stop(input.handle);
                return {
                    status: "ok",
                    handle: stopped.info.handle,
                    state: stopped.info.state,
                    ...backgroundExit(stopped.info),
                    output: clean(stopped.output),
                    ...(stopped.more ? { moreOutput: true } : {}),
                };
            })(),
        });
    }
    return tools;
};
