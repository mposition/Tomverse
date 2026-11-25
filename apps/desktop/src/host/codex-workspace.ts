import { EventEmitter, once } from "node:events";
import { z } from "zod";
import { canonicalDigest } from "../../../tomverse-cli/src/session.js";
import { readFileTool } from "../../../tomverse-cli/src/tools.js";
import { Workspace } from "../../../tomverse-cli/src/workspace.js";
import { hasCredential } from "./journal-view";
import { nativeListInput, nativeListName, nativeReadInput, nativeReadName, startNativeMcpServer } from "./native-mcp-server";
import { assertProjectRoot, type ProjectRoot } from "./project-root";

const readCall = z.object({ id: z.string().regex(/^[\w.:-]{1,160}$/), type: z.literal("mcpToolCall"),
  server: z.literal("desktop"), status: z.enum(["inProgress", "completed", "failed"]),
}).and(z.discriminatedUnion("tool", [
  z.object({ tool: z.literal(nativeReadName), arguments: nativeReadInput }),
  z.object({ tool: z.literal(nativeListName), arguments: nativeListInput }),
]));

type WorkspaceRead = { tool: typeof nativeReadName | typeof nativeListName;
  args: unknown; digest: string; served: boolean };

export async function startCodexWorkspace(input: { project: ProjectRoot; protectedRoots: string[]; connectionKey: string; signal: AbortSignal }) {
  const workspace = new Workspace(input.project.path, input.protectedRoots);
  const events = new EventEmitter();
  const reads = new Map<string, WorkspaceRead>();
  const startRead = (id: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    assertProjectRoot(input.project);
    const read = reads.get(id);
    if (!read) throw new Error("Codex did not request this file.");
    return read;
  };
  const server = await startNativeMcpServer({
    read: (id, args, signal) => {
      const read = startRead(id, signal);
      const result = readFileTool({ workspace, readByteLimit: 256 * 1024 }, args);
      if (result.status !== "ok" || typeof result.text !== "string" || hasCredential(result.text, input.connectionKey)) {
        throw new Error("The file could not be read.");
      }
      read.served = true;
      return result.text;
    },
    list: async (id, args, signal) => {
      const read = startRead(id, signal);
      const result = await workspace.listFilesAsync(args.path ?? ".", 200, signal);
      signal.throwIfAborted();
      assertProjectRoot(input.project);
      if (reads.get(id) !== read) throw new Error("The Codex workspace request changed.");
      read.served = true;
      return JSON.stringify({ ...result, files: result.files.filter((file) => !hasCredential(file, input.connectionKey)) });
    },
  }, input.signal, async (args, signal, name) => {
    if (name !== nativeReadName && name !== nativeListName) return;
    const digest = canonicalDigest(args);
    const wait = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    while (!wait.aborted) {
      const matches = [...reads.entries()].filter(([, read]) => read.tool === name && read.digest === digest && !read.served);
      if (matches.length > 1) return;
      if (matches.length === 1) {
        const [id, read] = matches[0]!;
        return { id, input: read.args, canApply: () => reads.get(id) === read && !read.served };
      }
      await once(events, "request", { signal: wait });
    }
  });

  return {
    ...server,
    clear: () => reads.clear(),
    observe(item: unknown, started: boolean) {
      const parsed = readCall.safeParse(item);
      if (!parsed.success) return;
      const call = parsed.data;
      const digest = canonicalDigest(call.arguments);
      const tool = call.tool === nativeReadName ? "read_file" as const : "list_files" as const;
      if (started && call.status === "inProgress" && !reads.has(call.id)) {
        if (reads.size >= 64) throw new Error("Too many Codex workspace reads to verify the turn.");
        reads.set(call.id, { tool: call.tool, args: call.arguments, digest, served: false });
        events.emit("request");
        return { id: call.id, tool, state: "running" } as const;
      }
      const read = reads.get(call.id);
      if (started || call.status === "inProgress" || !read || read.tool !== call.tool || read.digest !== digest) return;
      reads.delete(call.id);
      return { id: call.id, state: read.served && call.status === "completed" ? "succeeded" : "failed" } as const;
    },
  };
}

export type CodexWorkspace = Awaited<ReturnType<typeof startCodexWorkspace>>;
