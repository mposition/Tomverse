import { z } from "zod";
import { canonicalDigest } from "../../../tomverse-cli/src/session.js";
import type { Frame } from "./cli-protocol";
import { nativePatchName, type NativePatchTool } from "./native-patches";

export const claudePatchServer = "desktop";
export const claudePatchToolName = `mcp__${claudePatchServer}__${nativePatchName}`;
export const claudeId = z.string().regex(/^[\w.:-]{1,160}$/);
const rpcId = z.union([z.int().nonnegative(), claudeId]);
const request = z.object({
  request_id: claudeId,
  request: z.object({
    subtype: z.literal("mcp_message"), server_name: z.literal(claudePatchServer),
    message: z.object({ jsonrpc: z.literal("2.0"), id: rpcId.optional(), method: z.string(), params: z.unknown().optional() }),
  }),
});
const call = z.object({
  name: z.literal(nativePatchName), arguments: z.record(z.string(), z.unknown()),
  _meta: z.object({ "claudecode/toolUseId": claudeId }),
});
type PatchResult = Awaited<ReturnType<NativePatchTool["invoke"]>>;
export type ClaudePatchProposal = { input: unknown; canApply: () => boolean; result?: PatchResult; dispatched?: true };

export function claudePatchProtocol(tool: NativePatchTool, send: (frame: Frame) => void, signal: AbortSignal,
  proposalFor: (id: string) => ClaudePatchProposal | undefined, fail: (error: Error) => void) {
  let stage: "new" | "initializing" | "initialized" | "ready" = "new";
  let running: { id: string; abort: AbortController; finished: Promise<void> } | undefined;
  const respond = (requestId: string, id: z.infer<typeof rpcId> | undefined, result: unknown) => {
    send({ type: "control_response", response: { subtype: "success", request_id: requestId,
      response: { mcp_response: { jsonrpc: "2.0", id, result } } } });
  };
  return {
    receive(frame: Frame) {
      if (frame.type === "control_cancel_request" && running && running.id === frame.request_id) {
        running.abort.abort();
        return;
      }
      const { request_id: requestId, request: { message } } = request.parse(frame);
      const { id, method, params } = message;
      if (method === "initialize" && stage === "new" && id !== undefined) {
        const { protocolVersion } = z.object({ protocolVersion: z.literal("2025-11-25") }).parse(params);
        stage = "initializing";
        respond(requestId, id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: claudePatchServer, version: "1.0.0" } });
      } else if (method === "notifications/initialized" && stage === "initializing" && id === undefined) {
        stage = "initialized";
        respond(requestId, id, {});
      } else if (method === "tools/list" && stage === "initialized" && id !== undefined) {
        stage = "ready";
        const { name, description, inputSchema } = tool.spec;
        respond(requestId, id, { tools: [{ name, description, inputSchema }] });
      } else if (method === "tools/call" && stage === "ready" && id !== undefined && !running) {
        const parsed = call.parse(params);
        const toolId = parsed._meta["claudecode/toolUseId"];
        const proposal = proposalFor(toolId);
        if (!proposal || proposal.dispatched || canonicalDigest(proposal.input) !== canonicalDigest(parsed.arguments)) {
          throw new Error("Claude Code sent a patch without a matching tool call.");
        }
        proposal.dispatched = true;
        if (!proposal.canApply()) {
          const text = "No approved Desktop file edit was applied. Record the read-only analysis in the active task description before proposing a patch.";
          proposal.result = { success: false, text };
          respond(requestId, id, { content: [{ type: "text", text }], isError: true });
          return;
        }
        const abort = new AbortController();
        const patchSignal = AbortSignal.any([signal, abort.signal]);
        const finished = tool.invoke(toolId, parsed.arguments, patchSignal, async () => proposal.canApply()).then((result) => {
          proposal.result = result;
          respond(requestId, id, { content: [{ type: "text", text: result.text }], isError: !result.success });
        }).catch(() => fail(new Error("The Desktop patch outcome could not be confirmed."))).finally(() => {
          running = undefined;
        });
        running = { id: requestId, abort, finished };
      } else {
        throw new Error("Claude Code sent an unexpected Desktop patch request.");
      }
    },
    async close() {
      running?.abort.abort();
      await running?.finished;
    },
  };
}
