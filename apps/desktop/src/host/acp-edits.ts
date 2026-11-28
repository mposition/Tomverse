import { dirname, isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { same, type Workspace } from "../../../tomverse-cli/src/workspace.js";
import { readFileTool } from "../../../tomverse-cli/src/tools.js";
import type { NativePatchTool } from "./native-patches";

export const acpRpcId = z.union([z.string().max(160), z.int().nonnegative()]);
type RpcId = z.infer<typeof acpRpcId>;
const path = z.string().min(1).max(4096).refine(isAbsolute);
const text = z.string().max(128 * 1024);
const options = z.array(z.object({ optionId: z.string().min(1).max(160),
    kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]) })).max(8),
  callId = z.string().regex(/^[\w.:-]{1,160}$/);
const qwenPermission = z.object({
  options,
  toolCall: z.object({ toolCallId: callId, status: z.literal("pending"), kind: z.literal("edit"),
    rawInput: z.object({ file_path: path, content: text }),
    content: z.tuple([z.object({ type: z.literal("diff"), path, oldText: text, newText: text })]),
    _meta: z.object({ toolName: z.literal("write_file") }),
  }),
});
export const kimiWriteInput = z.object({ path, content: text }).strict();
const kimiPermission = z.object({ options, toolCall: z.object({ toolCallId: callId, title: z.literal("Write") }) });
const qwenWrite = z.object({ path, content: text, _meta: z.object({
  bom: z.literal(false).optional(),
  "qwen-code/tool-write-origin": z.object({ version: z.literal(1), source: z.literal("write_file") }),
}) });
const kimiWrite = z.object({ path, content: text });
type Reply = (id: RpcId, result: object) => void;
const samePath = (first: string, second: string) => same(normalize(first), normalize(second));
type Permission = { callId: string; options: z.infer<typeof options>; path: string; content: string; oldText?: string };

function qwenProposal(params: unknown): Permission | undefined {
  const parsed = qwenPermission.safeParse(params);
  if (!parsed.success) return undefined;
  const { options, toolCall: { toolCallId, rawInput, content: [diff] } } = parsed.data;
  if (rawInput.content !== diff.newText || !samePath(rawInput.file_path, diff.path)) return undefined;
  return { callId: toolCallId, options, path: diff.path, content: diff.newText, oldText: diff.oldText };
}

export function acpEdits(workspace: Workspace, patchTool: NativePatchTool | undefined, signal: AbortSignal,
  reply: Reply, refuse: (id: RpcId) => void, canWrite: (callId: string) => boolean,
  kimi?: (id: string) => z.infer<typeof kimiWriteInput> | undefined) {
  let waiting: { path: string; content: string; resolve: (id: RpcId | undefined) => void } | undefined;
  let job: Promise<void> | undefined;
  const written = new Set<string>();
  const requested = new Set<string>();
  function proposal(params: unknown): Permission | undefined {
    if (!kimi) return qwenProposal(params);
    const parsed = kimiPermission.safeParse(params);
    if (!parsed.success) return undefined;
    const callId = parsed.data.toolCall.toolCallId;
    const write = kimi(callId);
    return write && { callId, options: parsed.data.options, ...write };
  }
  return {
    permission(requestId: RpcId, params: unknown) {
      const proposed = proposal(params);
      const cancelled = { outcome: { outcome: "cancelled" } };
      if (!proposed || !patchTool || job || signal.aborted) {
        reply(requestId, cancelled);
        return;
      }
      const { options, callId: toolCallId, path, content } = proposed;
      const allow = options.filter(({ kind }) => kind === "allow_once");
      const reject = options.filter(({ kind }) => kind === "reject_once");
      const deny = () => reply(requestId, signal.aborted || reject.length !== 1 ? cancelled :
        { outcome: { outcome: "selected", optionId: reject[0]!.optionId } });
      if (allow.length !== 1 || !canWrite(toolCallId) || requested.has(toolCallId) ||
          new Set(options.map(({ optionId }) => optionId)).size !== options.length) {
        deny();
        return;
      }
      requested.add(toolCallId);
      let relative: string;
      let exists: boolean;
      let oldText = proposed.oldText ?? "";
      try {
        const target = workspace.resolve(path, "write");
        if (target.exists && proposed.oldText === undefined) {
          const read = readFileTool({ workspace, readByteLimit: 128 * 1024 }, { path });
          if (read.status !== "ok" || read.truncated || typeof read.text !== "string") throw new Error("Unavailable preimage.");
          oldText = read.text;
        }
        if (!workspace.resolve(dirname(target.absolute), "write").exists || (target.exists && !oldText) ||
            (!target.exists && oldText) || oldText === content) throw new Error("Unsupported edit.");
        ({ relative, exists } = target);
      } catch {
        deny();
        return;
      }
      const edit = exists ? { path: relative, action: "update", replacements: [{ old: oldText, new: content }] } :
        { path: relative, action: "create", content };
      let allowed = false;
      let writeId: RpcId | undefined;
      const cancel = () => waiting?.resolve(undefined);
      job = patchTool.invoke(toolCallId, { edits: [edit] }, signal, async ({ patch }, patchSignal) => {
        if (patchSignal.aborted || !canWrite(toolCallId) || patch?.length !== 1 || patch[0]?.afterText !== content ||
            (patch[0]?.beforeText ?? "") !== oldText) return false;
        writeId = await new Promise<RpcId | undefined>((resolve) => {
          waiting = { path, content, resolve };
          signal.addEventListener("abort", cancel, { once: true });
          allowed = true;
          // The ACP action still needs the matching delegated write request before any bytes reach disk.
          reply(requestId, { outcome: { outcome: "selected", optionId: allow[0]!.optionId } });
        });
        return writeId !== undefined && canWrite(toolCallId);
      }).then(({ success }) => {
        if (!allowed) deny();
        if (writeId === undefined) return;
        if (success) {
          written.add(toolCallId);
          reply(writeId, {});
        } else refuse(writeId);
      }).catch(() => {
        if (!allowed) deny();
        if (writeId !== undefined) refuse(writeId);
      }).finally(() => {
        signal.removeEventListener("abort", cancel);
        waiting = undefined;
        job = undefined;
      });
    },
    write(requestId: RpcId, params: unknown) {
      const parsed = (kimi ? kimiWrite : qwenWrite).safeParse(params);
      if (!waiting || !parsed.success || signal.aborted || !samePath(waiting.path, parsed.data.path) || waiting.content !== parsed.data.content) {
        refuse(requestId);
        waiting?.resolve(undefined);
      } else waiting.resolve(requestId);
      waiting = undefined;
    },
    written: (callId: string) => written.has(callId),
    pending: () => !!job,
    async close() {
      waiting?.resolve(undefined);
      await job;
    },
  };
}
