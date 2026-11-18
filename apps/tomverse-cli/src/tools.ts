import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { commandEnv, planCommand, runCommand, CommandError, type CommandPlan } from "./commands.js";
import { currentDigest, planPatch, PatchError, removeFile, writeFileReplacing, type PatchEdit, type PlannedEdit } from "./patch.js";
import { canonicalDigest, JournalError, sha256, type Journal } from "./session.js";
import { PathError, ripgrepAvailable, isSecretPath, type Workspace } from "./workspace.js";

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
    signal: () => AbortSignal;
    onActivity: (line: string) => void;
    onCommandOutput: (stream: "stdout" | "stderr", text: string) => void;
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
    // The latest decision for this call counts; an older approval never outlives a later denial.
    const approval = ctx.journal.state.approvals.findLast((a) => a.toolCallId === toolCallId && a.toolName === toolName);
    if (!approval || approval.decision !== "approved" || approval.inputDigest !== digest) {
        return { ok: false as const, result: { status: "denied", error: "Not approved by the user for this exact input." } };
    }
    return { ok: true as const, digest, approval };
};

const startTool = (ctx: ToolContext, toolName: string, toolCallId: string, digest: string) => {
    ctx.journal.state.tools.push({ toolCallId, toolName, inputDigest: digest, state: "started", startedAt: new Date().toISOString() });
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

const readFileTool = (ctx: ToolContext, input: { path: string; startLine?: number; endLine?: number }) => {
    const resolved = ctx.workspace.resolve(input.path, "read");
    if (!resolved.exists) return { status: "error", error: `${resolved.relative} does not exist.` };
    const stat = statSync(resolved.absolute);
    if (!stat.isFile()) return { status: "error", error: `${resolved.relative} is not a file.` };
    if (stat.size > 8 * 1024 * 1024) return { status: "error", error: `${resolved.relative} is ${stat.size} bytes; too large to read. Search it instead.` };
    const bytes = readFileSync(resolved.absolute);
    if (bytes.subarray(0, 8192).includes(0)) return { status: "error", error: `${resolved.relative} looks binary.` };
    const text = bytes.toString("utf8").replace(/^﻿/, "");
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
        text: body,
    };
};

const searchTool = (ctx: ToolContext, input: { pattern: string; path?: string; regex?: boolean; caseSensitive?: boolean; maxResults?: number }) => {
    const where = ctx.workspace.resolve(input.path ?? ".", "read");
    const max = Math.min(500, Math.max(1, input.maxResults ?? 100));
    const matches: string[] = [];
    let truncated = false;
    if (ripgrepAvailable()) {
        // --null ends each path with NUL: a path may itself contain ':'.
        const args = ["--no-config", "--null", "--line-number", "--no-heading", "--color", "never", "--max-columns", "300", "--max-columns-preview", "--max-filesize", "1M"];
        if (!input.regex) args.push("--fixed-strings");
        if (!input.caseSensitive) args.push("--ignore-case");
        args.push("-e", input.pattern, "--", where.relative === "." ? "." : where.relative);
        const result = spawnSync("rg", args, { cwd: ctx.workspace.root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: false, timeout: 30_000, env: commandEnv() });
        if (result.status !== 0 && result.status !== 1) return { status: "error", error: (result.stderr || "search failed").slice(0, 500) };
        for (const line of (result.stdout ?? "").split(/\r?\n/)) {
            const end = line.indexOf("\0");
            // No NUL: not a match line we can attribute to a path (e.g. a name with a newline).
            if (end <= 0) continue;
            const file = line.slice(0, end).replace(/^\.[\\/]/, "").replaceAll("\\", "/");
            if (isSecretPath(file)) continue;
            // The same real-path rule as read_file: a match inside a link out of the folder is dropped.
            try {
                ctx.workspace.resolve(file, "read");
            } catch {
                continue;
            }
            if (matches.length >= max) {
                truncated = true;
                break;
            }
            matches.push(`${file}:${line.slice(end + 1)}`);
        }
        return { status: "ok", engine: "ripgrep", matches, truncated };
    }
    let re: RegExp;
    try {
        re = input.regex ? new RegExp(input.pattern, input.caseSensitive ? "" : "i") : new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), input.caseSensitive ? "" : "i");
    } catch (error) {
        return { status: "error", error: `Invalid pattern: ${(error as Error).message}` };
    }
    const listed = ctx.workspace.listFiles(where.relative, 20_000);
    outer: for (const file of listed.files) {
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
            if (!re.test(line)) continue;
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
    const results: Array<{ path: string; action: string; status: "applied" | "failed" | "not_attempted"; error?: string }> = [];
    let failed = false;
    for (const edit of planned) {
        if (failed) {
            results.push({ path: edit.path, action: edit.action, status: "not_attempted" });
            continue;
        }
        const changeId = `c${ctx.journal.state.changes.length + 1}-${randomBytes(3).toString("hex")}`;
        try {
            // Last look before the write: the file must still be what was approved.
            if (currentDigest(edit.absolute) !== edit.preimage) throw new PatchError(`${edit.path} changed after it was approved; it was not written.`);
            const backup = edit.preimage ? ctx.journal.saveBackup(changeId, readFileSync(edit.absolute)) : null;
            ctx.journal.state.changes.push({
                changeId,
                toolCallId,
                path: edit.path,
                kind: edit.action,
                preimage: { sha256: edit.preimage, backup },
                postimage: { sha256: edit.postimage },
                state: "writing",
            });
            ctx.journal.commit();
            if (edit.action === "delete") removeFile(edit.absolute);
            else writeFileReplacing(edit.absolute, edit.afterBytes!);
            const record = ctx.journal.state.changes.find((c) => c.changeId === changeId)!;
            record.state = currentDigest(edit.absolute) === edit.postimage ? "applied" : "failed";
            record.appliedAt = new Date().toISOString();
            ctx.journal.commit();
            if (record.state !== "applied") throw new PatchError(`${edit.path} does not hold the written content afterwards.`);
            results.push({ path: edit.path, action: edit.action, status: "applied" });
        } catch (error) {
            failed = true;
            const record = ctx.journal.state.changes.find((c) => c.changeId === changeId);
            if (record && record.state === "writing") {
                record.state = currentDigest(edit.absolute) === edit.postimage ? "applied" : "failed";
                try {
                    ctx.journal.commit();
                } catch {
                    // reported by the caller's next commit
                }
            }
            if (error instanceof JournalError) throw error;
            results.push({ path: edit.path, action: edit.action, status: record?.state === "applied" ? "applied" : "failed", error: (error as Error).message });
        }
    }
    const applied = results.filter((r) => r.status === "applied").length;
    return {
        status: failed ? (applied ? "partial" : "error") : "ok",
        files: results,
        note: failed ? "Not every file was written. Files are written one by one; the ones marked applied are changed, the rest are not." : undefined,
    };
};

export const createTools = (ctx: ToolContext, readOnly: boolean): ToolSet => {
    const tools: ToolSet = {
        list_files: tool({
            description: "List files under a folder of the workspace (bounded; skips generated folders and credential files).",
            inputSchema: z.object({ path: z.string().optional(), limit: z.number().optional() }),
            execute: async (input) => {
                try {
                    ctx.onActivity(`list_files ${input.path ?? "."}`);
                    const listed = ctx.workspace.listFiles(input.path ?? ".", Math.min(2000, Math.max(1, input.limit ?? 500)));
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
                    ctx.onActivity(`search_text ${JSON.stringify(input.pattern)}${input.path ? ` in ${input.path}` : ""}`);
                    return searchTool(ctx, input);
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
            const drift = planned.filter((p) => bound.find((b) => b.path === p.path)?.preimage !== p.preimage || !bound.some((b) => b.path === p.path));
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
            startTool(ctx, "run_command", toolCallId, decision.digest);
            ctx.onActivity(`run ${plan.display}`);
            const result = await runCommand(plan, ctx.signal(), ctx.onCommandOutput, ctx.commandEnv);
            const output = {
                status: result.spawnError ? "error" : result.cancelled ? "cancelled" : result.timedOut ? "timeout" : "ok",
                exitCode: result.exitCode,
                signal: result.signal,
                durationMs: result.durationMs,
                stdout: result.stdout,
                stderr: result.stderr,
                ...(result.stdoutOmittedBytes || result.stderrOmittedBytes ? { omittedBytes: { stdout: result.stdoutOmittedBytes, stderr: result.stderrOmittedBytes } } : {}),
                ...(result.residualProcesses.length ? { residualProcesses: result.residualProcesses } : {}),
                ...(result.spawnError ? { error: result.spawnError } : {}),
            };
            return endTool(ctx, toolCallId, result.spawnError ? "failed" : "completed", output);
        },
    });
    return tools;
};
