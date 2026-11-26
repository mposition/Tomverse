import { randomBytes } from "node:crypto";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { CommandError, type CommandPlan } from "./commands.js";
import { PatchError, type PatchEdit, type PlannedEdit } from "./patch.js";
import { planRemoteCommand, type RemoteWorkspace } from "./remote-workspace.js";
import { RemoteError, type RemoteTarget } from "./remote-target.js";
import { JournalError, sha256 } from "./session.js";
import {
    commandSchema, endTool, gate, IMAGE_MAX_BYTES, imageTypeOf, patchSchema, readTextResult, startTool,
    type CommandToolInput, type ImageAttachment, type PatchInput, type ToolContext,
} from "./tools.js";
import { PathError } from "./workspace.js";

/**
 * The file and command tools of a project on another machine. Same names, same inputs, same approvals and journal records as
 * the local tools (tools.ts); only where the files are differs. A tool of a remote project is never answered from this
 * computer's disk, and nothing here touches it.
 */

type RemoteToolContext = Pick<ToolContext, "assertAllowed" | "signal" | "onActivity" | "redactText" | "readByteLimit" | "attachImage">;

export const remoteToolError = (error: unknown) => {
    if (error instanceof RemoteError) {
        const lost = error.code === "connection-lost" || error.code === "timeout" || error.code === "auth" || error.code === "host-key"
            || error.code === "host-key-changed" || error.code === "unreachable" || error.code === "name-not-found" || error.code === "ssh-missing";
        return { status: "error" as const, error: error.message, ...(lost ? { connectionLost: true, note: "The connection to the remote machine is not usable. Stop here and tell the person; they can reconnect and continue." } : {}) };
    }
    return {
        status: "error" as const,
        error: error instanceof PathError || error instanceof PatchError || error instanceof CommandError ? error.message : `Failed: ${(error as Error).message}`,
    };
};

/** The approval's view of a patch, read from the remote files now. */
export const planRemotePatchCall = (remote: RemoteWorkspace, input: PatchInput, signal?: AbortSignal) => remote.planPatch(input.edits as PatchEdit[], signal);

/** The approval's view of a command: where it will run, resolved on the remote machine. */
export const planRemoteCommandCall = async (remote: RemoteWorkspace, ctx: Pick<ToolContext, "commandTimeoutMs">, input: CommandToolInput, signal?: AbortSignal): Promise<CommandPlan> => {
    if (input.background) throw new CommandError("Background commands are not available in a remote project; run the command in the foreground.");
    const cwd = await remote.resolve(input.cwd ?? ".", "read", signal);
    if (cwd.kind !== "dir") throw new CommandError(`${cwd.relative} is not a folder on ${remote.label}.`);
    return planRemoteCommand(input, cwd.absolute, ctx.commandTimeoutMs);
};

/** What run_command tells the model: where the command really runs. */
export const remoteRunCommandDescription = (target: Pick<RemoteTarget, "destination" | "port">) =>
    `Run one command on the remote machine ${target.destination} (over SSH, in the project folder there) after the user approves it. It runs with the user's permissions on that machine and is not sandboxed. Prefer argv; use command for shell syntax (it runs in sh). stdin is closed; output is bounded; there is no background mode.`;

const guarded = (ctx: RemoteToolContext, remote: RemoteWorkspace) => {
    ctx.assertAllowed?.();
    ctx.signal().throwIfAborted();
    if (remote.blockReason) throw new RemoteError("connection-lost", remote.blockReason);
};

const clean = (ctx: RemoteToolContext, text: string) => ctx.redactText?.(text) ?? text;

export const remoteReadTools = (ctx: ToolContext, remote: RemoteWorkspace): ToolSet => {
    const tools: ToolSet = {
        list_files: tool({
            description: "List files under a folder of the remote project (bounded; skips generated folders and credential files).",
            inputSchema: z.object({ path: z.string().optional(), limit: z.number().optional() }),
            execute: async (input) => {
                try {
                    guarded(ctx, remote);
                    ctx.onActivity(`list_files ${input.path ?? "."} (${remote.label})`);
                    const listed = await remote.listFiles(input.path ?? ".", Math.min(2000, Math.max(1, input.limit ?? 500)), ctx.signal());
                    return { status: "ok", ...listed, source: "remote" };
                } catch (error) {
                    return remoteToolError(error);
                }
            },
        }),
        search_text: tool({
            description: "Search file contents in the remote project (grep on that machine). Literal by default; regex: true for an extended regular expression. Letter case is ignored unless caseSensitive is true.",
            inputSchema: z.object({ pattern: z.string(), path: z.string().optional(), regex: z.boolean().optional(), caseSensitive: z.boolean().optional(), maxResults: z.number().optional() }),
            execute: async (input) => {
                try {
                    guarded(ctx, remote);
                    ctx.onActivity(`search_text ${JSON.stringify(input.pattern)}${input.path ? ` in ${input.path}` : ""} (${remote.label})`);
                    const found = await remote.searchText({ ...input, maxResults: Math.min(500, Math.max(1, input.maxResults ?? 100)) }, ctx.signal());
                    return { status: "ok", engine: "grep", matches: found.matches.map((line) => clean(ctx, line)), truncated: found.truncated };
                } catch (error) {
                    return remoteToolError(error);
                }
            },
        }),
        read_file: tool({
            description: "Read a text file of the remote project, up to 2000 lines per call; use startLine/endLine for more.",
            inputSchema: z.object({ path: z.string(), startLine: z.number().optional(), endLine: z.number().optional() }),
            execute: async (input) => {
                try {
                    guarded(ctx, remote);
                    ctx.onActivity(`read_file ${input.path}${input.startLine ? `:${input.startLine}-${input.endLine ?? ""}` : ""} (${remote.label})`);
                    const resolved = await remote.resolve(input.path, "read", ctx.signal());
                    if (!resolved.exists) return { status: "error", error: `${resolved.relative} does not exist.` };
                    if (resolved.kind !== "file") return { status: "error", error: `${resolved.relative} is not a file.` };
                    const { bytes } = await remote.readFile(resolved.absolute, 8 * 1024 * 1024, ctx.signal());
                    return readTextResult(ctx, resolved.relative, bytes, input);
                } catch (error) {
                    return remoteToolError(error);
                }
            },
        }),
    };
    if (ctx.attachImage) {
        const attach = ctx.attachImage;
        tools.view_image = tool({
            description: "Look at an image file of the remote project (PNG, JPEG, WebP or GIF, up to 3 MB). Only for models that can see images. Needs no approval; the same files as read_file.",
            inputSchema: z.object({ path: z.string() }),
            execute: async (input) => {
                try {
                    guarded(ctx, remote);
                    ctx.onActivity(`view_image ${input.path} (${remote.label})`);
                    const resolved = await remote.resolve(input.path, "read", ctx.signal());
                    if (!resolved.exists) return { status: "error", error: `${resolved.relative} does not exist.` };
                    if (resolved.kind !== "file") return { status: "error", error: `${resolved.relative} is not a file.` };
                    const { bytes } = await remote.readFile(resolved.absolute, IMAGE_MAX_BYTES, ctx.signal());
                    const mediaType = imageTypeOf(bytes);
                    if (!mediaType) return { status: "error", error: `${resolved.relative} is not a PNG, JPEG, WebP or GIF image.` };
                    attach({ path: resolved.relative, mediaType, base64: bytes.toString("base64"), bytes: bytes.length } satisfies ImageAttachment);
                    return { status: "ok", path: resolved.relative, mediaType, bytes: bytes.length, note: "The image is attached to the next message from the user; look at it there." };
                } catch (error) {
                    return remoteToolError(error);
                }
            },
        });
    }
    return tools;
};

/** Mirrors applyPlannedPatch (tools.ts): one change at a time, a journal record before the write and after, a backup of both images. */
export const applyRemotePatch = async (ctx: ToolContext, remote: RemoteWorkspace, toolCallId: string, planned: PlannedEdit[]) => {
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
            guarded(ctx, remote);
        };
        try {
            ctx.beforeWrite?.(edit, toolCallId);
            guard();
            let before: Buffer | null = null;
            if (edit.preimage) {
                const read = await remote.readFile(edit.absolute, 8 * 1024 * 1024, ctx.signal());
                before = read.bytes;
                if (sha256(before) !== edit.preimage || read.ident !== edit.binding.file) throw new PatchError(`${edit.path} changed while its backup was being read.`);
            }
            const mode = edit.binding.file ? Number.parseInt(edit.binding.file.split(":")[2] ?? "", 8) : Number.NaN;
            ctx.journal.state.changes.push({
                changeId,
                toolCallId,
                path: edit.path,
                kind: edit.action,
                preimage: { sha256: edit.preimage, backup: before ? ctx.journal.saveBackup(changeId, before) : null,
                    identity: edit.binding.file, ...(before && Number.isFinite(mode) ? { mode } : {}) },
                postimage: { sha256: edit.postimage, backup: edit.afterBytes ? ctx.journal.saveBackup(changeId, edit.afterBytes, "post") : null },
                state: "writing",
            });
            ctx.journal.commit();
            ctx.beforeWrite?.(edit, toolCallId);
            guard();
            // From here the outcome is not known until the machine answers: a connection that ends now may or may not have written.
            wrote = true;
            let identity: string | null = null;
            let directory = edit.binding.directory;
            if (edit.action === "delete") await remote.removeFile(edit, ctx.signal());
            else {
                const written = await remote.writeFile(edit, ctx.signal());
                identity = written.ident;
                directory = written.folderIdent;
            }
            const record = ctx.journal.state.changes.find((c) => c.changeId === changeId)!;
            record.directory = directory;
            record.postimage.identity = identity;
            const check = edit.action === "delete" ? null : await remote.readFile(edit.absolute, 8 * 1024 * 1024, ctx.signal());
            const holds = edit.action === "delete" ? !(await remote.resolve(edit.path, "read", ctx.signal())).exists : sha256(check!.bytes) === edit.postimage;
            record.state = holds ? "applied" : "writing";
            record.appliedAt = new Date().toISOString();
            ctx.journal.commit();
            if (record.state !== "applied") throw new PatchError(`${edit.path} does not hold the written content afterwards.`);
            results.push({ path: edit.path, action: edit.action, status: "applied" });
        } catch (error) {
            failed = true;
            const record = ctx.journal.state.changes.find((c) => c.changeId === changeId);
            // A write the machine refused changed nothing; an answer that never came is not known.
            const refused = error instanceof RemoteError && !["connection-lost", "timeout", "auth", "host-key", "host-key-changed", "unreachable", "name-not-found", "ssh-missing", "protocol"].includes(error.code);
            if (record && record.state === "writing") {
                record.state = wrote && !refused ? "writing" : "failed";
                try {
                    ctx.journal.commit();
                } catch {
                    // reported by the caller's next commit
                }
            }
            if (error instanceof JournalError) throw error;
            const status = record?.state === "applied" ? "applied" : wrote && !refused ? "unconfirmed" : "failed";
            results.push({ path: edit.path, action: edit.action, status, error: (error as Error).message });
        }
    }
    const applied = results.filter((r) => r.status === "applied").length;
    return {
        status: failed ? (applied ? "partial" : "error") : "ok",
        files: results,
        note: failed ? "Files are changed one at a time, each replaced in one step on the remote machine. Check the outcome of every file, especially any marked unconfirmed, before retrying." : undefined,
    };
};

export const remoteWriteTools = (ctx: ToolContext, remote: RemoteWorkspace): ToolSet => ({
    apply_patch: tool({
        description:
            "Create, update (exact text replacements) or delete files of the remote project. The user sees the diff and must approve it. Read a file before updating it; each old text must occur exactly once.",
        inputSchema: patchSchema,
        execute: async (input, { toolCallId }) => {
            const decision = gate(ctx, "apply_patch", toolCallId, input);
            if (!decision.ok) return decision.result;
            let planned: PlannedEdit[];
            try {
                guarded(ctx, remote);
                planned = await planRemotePatchCall(remote, input, ctx.signal());
            } catch (error) {
                return remoteToolError(error);
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
            const result = await applyRemotePatch(ctx, remote, toolCallId, planned);
            return endTool(ctx, toolCallId, result.status === "ok" ? "completed" : "failed", result);
        },
    }),
    run_command: tool({
        description: remoteRunCommandDescription(remote.target),
        inputSchema: commandSchema,
        execute: async (input, { toolCallId }) => {
            const decision = gate(ctx, "run_command", toolCallId, input);
            if (!decision.ok) return decision.result;
            let plan: CommandPlan;
            try {
                guarded(ctx, remote);
                plan = await planRemoteCommandCall(remote, ctx, input, ctx.signal());
            } catch (error) {
                return remoteToolError(error);
            }
            if (decision.approval.binding.cwd !== plan.cwd) {
                return { status: "error", error: "The working folder resolves differently than when it was approved; not run." };
            }
            if ((decision.approval.binding.background ?? false) !== (plan.background ?? false)) {
                return { status: "error", error: "The approval was for a different kind of run (background or not); not run." };
            }
            if (decision.approval.binding.program !== undefined && decision.approval.binding.program !== plan.file) {
                return { status: "error", error: `The program now is ${plan.file}, not the ${decision.approval.binding.program} that was approved; not run.` };
            }
            try { guarded(ctx, remote); ctx.beforeCommand?.(plan, toolCallId); } catch (error) { return remoteToolError(error); }
            startTool(ctx, "run_command", toolCallId, decision.digest, plan);
            ctx.onActivity(`run ${plan.display} on ${remote.label}`);
            const execution = remote.exec(plan, ctx.signal(), ctx.onCommandOutput).then((result) => {
                const output = {
                    status: result.lost ? "error" : result.spawnError ? "error" : result.cancelled ? "cancelled" : result.timedOut ? "timeout" : "ok",
                    exitCode: result.exitCode,
                    signal: result.signal,
                    durationMs: result.durationMs,
                    stdout: clean(ctx, result.stdout),
                    stderr: clean(ctx, result.stderr),
                    ...(result.stdoutOmittedBytes || result.stderrOmittedBytes ? { omittedBytes: { stdout: result.stdoutOmittedBytes, stderr: result.stderrOmittedBytes } } : {}),
                    ...(result.lost ? {
                        error: result.lost.message, connectionLost: true,
                        note: "The connection ended while the command was running. It may still be running or may have finished: its outcome is not known. Stop here and tell the person; do not run it again before checking.",
                    } : { processTreeChecked: false, note: `The command ran on ${remote.label}; the machine ends it when the connection ends, and its processes there cannot be listed from here.` }),
                };
                return endTool(ctx, toolCallId, result.lost ? "failed" : "completed", output);
            }, (error: unknown) => endTool(ctx, toolCallId, "failed", remoteToolError(error)));
            ctx.trackExecution?.(execution);
            return execution;
        },
    }),
});
