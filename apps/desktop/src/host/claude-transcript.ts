import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, normalize } from "node:path";
import { z } from "zod";
import { same, Workspace } from "../../../tomverse-cli/src/workspace.js";
import type { CodeNativeAssignment, CodeTaskPlan } from "../contract";
import { bindClaudeRead, claudeReadInput, claudeReadReceipt } from "./claude-read";
import { assertProjectRoot, type ProjectRoot } from "./project-root";

const maxBytes = 16 * 1024 * 1024;
const header = z.object({
  type: z.enum(["user", "assistant"]), uuid: z.uuid(), sessionId: z.uuid(),
  cwd: z.string().min(1).max(4096), version: z.string(), isSidechain: z.literal(false),
  message: z.object({ role: z.enum(["user", "assistant"]), model: z.string().optional(), content: z.array(z.unknown()).max(32) }),
  permissionMode: z.string().optional(), promptSource: z.string().optional(), promptId: z.uuid().optional(),
  parentUuid: z.uuid().nullable(), sourceToolAssistantUUID: z.uuid().optional(), toolUseResult: z.unknown().optional(),
});
const readCall = z.object({ type: z.literal("tool_use"), id: z.string(), name: z.literal("Read"), input: claudeReadInput });
const result = z.object({ type: z.literal("tool_result"), tool_use_id: z.string(), is_error: z.boolean().optional() });
type Evidence = CodeTaskPlan["items"][number]["evidence"][number];
type ReadOutcome = "succeeded" | "failed" | "unconfirmed";

export async function assertLocalClaudeDirectory(path: string) {
  if (!(await lstat(path)).isDirectory() || !same(await realpath(path), path)) throw new Error("The saved Claude Code folder changed.");
}

export async function findClaudeTranscript(profile: string, sessionId: string) {
  await assertLocalClaudeDirectory(profile);
  const projects = join(profile, "projects");
  await assertLocalClaudeDirectory(projects);
  const name = `${z.uuid().parse(sessionId)}.jsonl`;
  const matches: string[] = [];
  for (const entry of await readdir(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(projects, entry.name);
    await assertLocalClaudeDirectory(directory);
    const transcript = join(directory, name);
    const stat = await lstat(transcript).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!stat) continue;
    if (!stat.isFile() || !stat.size || stat.size > maxBytes || !same(await realpath(transcript), transcript)) {
      throw new Error("The saved Claude Code transcript changed.");
    }
    matches.push(transcript);
  }
  if (matches.length !== 1) throw new Error("Claude Code did not save a unique conversation for this task.");
  return matches[0];
}

async function readTranscript(path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || !before.size || before.size > maxBytes) throw new Error("Invalid Claude Code transcript size.");
    const buffer = Buffer.alloc(before.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await lstat(path);
    signal.throwIfAborted();
    if (bytesRead !== before.size || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || !same(await realpath(path), path) ||
        buffer.at(-1) !== 10) throw new Error("The Claude Code transcript changed while reading it.");
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}

export async function inspectClaudeTranscript(input: { profile: string; project: ProjectRoot; session: CodeNativeAssignment;
  version: string; plan?: CodeTaskPlan; signal: AbortSignal }) {
  const { session, project, signal } = input;
  if (session.provider !== "anthropic") return undefined;
  const expected = new Map<string, Evidence>();
  for (const row of input.plan?.items ?? []) {
    for (const evidence of row.evidence) {
      const { assignment, nativeItemId } = evidence;
      if (evidence.tool !== "read_file" || !nativeItemId || !assignment || !("threadId" in assignment) ||
          assignment.threadId !== session.threadId || assignment.turnId !== session.turnId || assignment.model !== session.model) continue;
      if (expected.has(nativeItemId)) return undefined;
      expected.set(nativeItemId, evidence);
    }
  }
  const transcript = await findClaudeTranscript(input.profile, session.threadId);
  const text = await readTranscript(transcript, signal);
  const workspace = new Workspace(project.path);
  const calls = new Map<string, { uuid: string; path: string }>();
  const receipts = new Map<string, { source: string; prompt: string; rejected: boolean; read?: z.infer<typeof claudeReadReceipt> }>();
  let promptId: string | undefined;
  for (const line of text.trimEnd().split("\n")) {
    signal.throwIfAborted();
    const record = header.safeParse(JSON.parse(line));
    if (!record.success) continue;
    const data = record.data;
    if (data.sessionId !== session.threadId || data.version !== input.version || !same(normalize(data.cwd), normalize(project.path)) ||
        data.type !== data.message.role) continue;
    if (data.type === "user" && data.uuid === session.turnId) {
      if (promptId || data.promptSource !== "sdk" || data.permissionMode !== "plan" || !data.promptId) return undefined;
      promptId = data.promptId;
    } else if (data.type === "assistant" && data.message.model === session.model) {
      for (const block of data.message.content) {
        const parsed = readCall.safeParse(block);
        if (!parsed.success || !expected.has(parsed.data.id)) continue;
        if (calls.has(parsed.data.id)) return undefined;
        calls.set(parsed.data.id, { uuid: data.uuid, path: parsed.data.input.file_path });
      }
    } else if (data.type === "user" && data.sourceToolAssistantUUID && data.parentUuid === data.sourceToolAssistantUUID && data.promptId) {
      for (const block of data.message.content) {
        const parsed = result.safeParse(block);
        if (!parsed.success || !expected.has(parsed.data.tool_use_id)) continue;
        if (receipts.has(parsed.data.tool_use_id)) return undefined;
        const read = claudeReadReceipt.safeParse(data.toolUseResult);
        receipts.set(parsed.data.tool_use_id, { source: data.sourceToolAssistantUUID, prompt: data.promptId,
          rejected: parsed.data.is_error === true, read: read.success ? read.data : undefined });
      }
    }
  }
  if (!promptId) return undefined;

  const outcomes = new Map<string, ReadOutcome>();
  for (const [id, evidence] of expected) {
    if (evidence.state === "succeeded" || evidence.state === "failed") {
      outcomes.set(id, evidence.state);
      continue;
    }
    outcomes.set(id, "unconfirmed");
    const call = calls.get(id);
    const receipt = receipts.get(id);
    if (!call || call.uuid !== evidence.nativeCallId || !receipt || receipt.source !== call.uuid || receipt.prompt !== promptId) continue;
    if (receipt.rejected) {
      outcomes.set(id, "failed");
      continue;
    }
    const read = receipt.read;
    if (!read || !evidence.nativeReadBinding ||
        bindClaudeRead(workspace, project, call.path) !== evidence.nativeReadBinding ||
        bindClaudeRead(workspace, project, read.file.filePath) !== evidence.nativeReadBinding) continue;
    outcomes.set(id, read.type === "text" ? "succeeded" : "failed");
  }
  assertProjectRoot(project);
  return outcomes;
}
