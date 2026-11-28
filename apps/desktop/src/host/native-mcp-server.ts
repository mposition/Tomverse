import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { canonicalDigest } from "../../../tomverse-cli/src/session.js";
import { patchSchema } from "../../../tomverse-cli/src/tools.js";
import { nativePatchName, type NativePatchTool } from "./native-patches";
import { maxNativePlanItems, nativePlanPhase } from "./native-task-rows";

const serverName = "desktop";
export const nativeReadName = "desktop_read_file";
export const nativeListName = "desktop_list_files";
export const nativeTaskListName = "desktop_update_tasks";
export const vibeReadFunction = "mcp_" + serverName + "." + nativeReadName;
export const vibePatchFunction = "mcp_" + serverName + "." + nativePatchName;
export const directMcpReadFunction = "mcp__" + serverName + "__" + nativeReadName;
export const directMcpPatchFunction = "mcp__" + serverName + "__" + nativePatchName;
export const nativeReadInput = z.object({ path: z.string().min(1).max(4096),
  startLine: z.int().min(1).max(10_000_000).optional(), endLine: z.int().min(1).max(10_000_000).optional() }).strict();
export const nativeListInput = z.object({ path: z.string().min(1).max(4096).optional() }).strict();
export const nativeTaskListInput = z.object({ items: z.array(z.object({
  id: z.string().regex(/^[\w.:-]{1,145}$/u), content: z.string().trim().min(1).max(1600), status: nativePlanPhase,
}).strict()).max(maxNativePlanItems) }).strict().refine(({ items }) =>
  new Set(items.map(({ id }) => id)).size === items.length &&
  items.filter(({ status }) => status === "in_progress").length <= 1);

type ToolName = typeof nativeReadName | typeof nativeListName | typeof nativePatchName | typeof nativeTaskListName;
type NativeMcpProposal = { id: string; input: unknown; canApply: () => boolean };

const rejected = { content: [{ type: "text" as const, text: "No approved Desktop file edit was applied." }], isError: true };
const readRejected = { content: [{ type: "text" as const, text: "The Desktop workspace file is unavailable." }], isError: true };

export async function startNativeMcpServer(
  tools: {
    patch?: NativePatchTool;
    read?: (id: string, args: z.infer<typeof nativeReadInput>, signal: AbortSignal) => string;
    list?: (id: string, args: z.infer<typeof nativeListInput>, signal: AbortSignal) => Promise<string>;
    onPatchResult?: (id: string, success: boolean) => void;
    acceptTaskList?: (id: string) => void;
  },
  signal: AbortSignal,
  proposalFor: (args: unknown, signal: AbortSignal, name: ToolName) => Promise<NativeMcpProposal | undefined>,
) {
  signal.throwIfAborted();
  const credential = "Bearer " + randomBytes(32).toString("hex");
  const expectedToken = Buffer.from(credential);
  const lifetime = new AbortController();
  const lifetimeSignal = AbortSignal.any([signal, lifetime.signal]);
  const claimed = new Set<string>();
  const path = "/mcp";
  let busy = false;
  const requests = new Set<Promise<void>>();

  async function serve(request: IncomingMessage, response: ServerResponse) {
    const token = Buffer.from(request.headers.authorization ?? "");
    if (lifetimeSignal.aborted || request.url !== path || request.headers.host !== host ||
        (request.headers.origin !== undefined && request.headers.origin !== "http://" + host) ||
        token.length !== expectedToken.length || !timingSafeEqual(token, expectedToken)) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    const disconnect = new AbortController();
    response.once("close", () => { if (!response.writableEnded) disconnect.abort(); });
    const server = new McpServer({ name: serverName, version: "1.0.0" });
    const channel = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    async function claim(args: unknown, requestSignal: AbortSignal, name: ToolName) {
      const proposal = await proposalFor(args, requestSignal, name);
      if (!proposal || requestSignal.aborted || claimed.has(proposal.id) || !proposal.canApply() ||
          canonicalDigest(proposal.input) !== canonicalDigest(args)) return;
      claimed.add(proposal.id);
      return proposal;
    }
    const read = tools.read;
    if (read) server.registerTool(nativeReadName, {
      description: "Read a file in the current Desktop workspace.", inputSchema: nativeReadInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async (args, extra) => {
      const requestSignal = AbortSignal.any([lifetimeSignal, disconnect.signal, extra.signal]);
      try {
        const proposal = await claim(args, requestSignal, nativeReadName);
        if (!proposal) return readRejected;
        return { content: [{ type: "text", text: read(proposal.id, args, requestSignal) }] };
      } catch {
        return readRejected;
      }
    });
    const list = tools.list;
    if (list) server.registerTool(nativeListName, {
      description: "List files under a directory in the current Desktop workspace.", inputSchema: nativeListInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async (args, extra) => {
      const requestSignal = AbortSignal.any([lifetimeSignal, disconnect.signal, extra.signal]);
      try {
        const proposal = await claim(args, requestSignal, nativeListName);
        if (!proposal) return readRejected;
        return { content: [{ type: "text", text: await list(proposal.id, args, requestSignal) }] };
      } catch {
        return readRejected;
      }
    });
    const acceptTaskList = tools.acceptTaskList;
    if (acceptTaskList) server.registerTool(nativeTaskListName, {
      description: "Publish the current ordered task list and update the status of its items.", inputSchema: nativeTaskListInput,
    }, async (args, extra) => {
      const requestSignal = AbortSignal.any([lifetimeSignal, disconnect.signal, extra.signal]);
      try {
        const proposal = await claim(args, requestSignal, nativeTaskListName);
        if (!proposal) throw new Error("No matching task list proposal.");
        acceptTaskList(proposal.id);
        return { content: [{ type: "text" as const, text: "Desktop received the task list." }] };
      } catch {
        return { content: [{ type: "text" as const, text: "Desktop rejected the task list." }], isError: true };
      }
    });
    const patch = tools.patch;
    if (patch) server.registerTool(nativePatchName, { description: patch.spec.description, inputSchema: patchSchema },
      async (args, extra) => {
        const requestSignal = AbortSignal.any([lifetimeSignal, disconnect.signal, extra.signal]);
        if (busy || requestSignal.aborted) return rejected;
        busy = true;
        try {
          const proposal = await claim(args, requestSignal, nativePatchName);
          if (!proposal) return rejected;
          const result = await patch.invoke(proposal.id, args, requestSignal, async () => proposal.canApply());
          tools.onPatchResult?.(proposal.id, result.success);
          return { content: [{ type: "text", text: result.text }], isError: !result.success };
        } catch {
          return { content: [{ type: "text", text: "The Desktop patch result could not be confirmed." }], isError: true };
        } finally {
          busy = false;
        }
      });
    try {
      await server.connect(channel);
      await channel.handleRequest(request, response);
    } finally {
      await server.close();
    }
  }

  const listener = createServer((request, response) => {
    const work = serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    }).finally(() => { requests.delete(work); });
    requests.add(work);
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") {
    listener.close();
    throw new Error("The Desktop patch server did not acquire a loopback address.");
  }
  const host = "127.0.0.1:" + address.port;
  let closed: Promise<void> | undefined;
  const close = () => {
    if (closed) return closed;
    signal.removeEventListener("abort", stop);
    lifetime.abort();
    closed = new Promise<void>((resolve, reject) => {
      listener.close((error) => { if (error) reject(error); else resolve(); });
      listener.closeAllConnections();
    }).then(async () => { await Promise.allSettled(requests); });
    return closed;
  };
  const stop = () => { void close().catch(() => undefined); };
  // Dispose the server immediately if the run stopped while it was binding the port.
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return { descriptor: { type: "http" as const, name: serverName, url: "http://" + host + path,
    headers: [{ name: "Authorization", value: credential }] }, close };
}
