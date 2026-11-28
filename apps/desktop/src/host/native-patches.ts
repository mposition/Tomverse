import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULTS, Journal, Workspace, canonicalDigest, resolveEndpoint, same, viewChange, type ApprovalView } from "../../../tomverse-cli/src/runtime.js";
import { assertBoundFile } from "../../../tomverse-cli/src/patch.js";
import { createTools, patchSchema, planPatchCall, type ToolContext } from "../../../tomverse-cli/src/tools.js";
import { assertProjectRoot, type ProjectRoot } from "./project-root";
import { hasCredential } from "./journal-view";
export const nativePatchName = "desktop_apply_patch";

export type NativePatchTool = {
  spec: { type: "function"; name: typeof nativePatchName; description: string; inputSchema: unknown };
  invoke: (callId: string, args: unknown, signal: AbortSignal, waitForWrite?: (view: ApprovalView, signal: AbortSignal) => Promise<boolean>) =>
    Promise<{ success: boolean; text: string }>;
};

const editsHome = (source: string) => join(source, "edits");
const resultSchema = z.object({ status: z.enum(["ok", "partial", "error", "unknown", "denied"]) });

export function openNativeEdits(source: string, taskId: string, project: ProjectRoot) {
  const home = editsHome(source);
  const location = join(home, "sessions", taskId);
  assertProjectRoot(project);
  if (!lstatSync(location).isDirectory() || !same(realpathSync(location), location)) throw new Error("The native edit record moved.");
  const journal = Journal.open(home, taskId);
  if (journal.state.id === taskId && same(journal.state.workspace.root, project.path) && !journal.state.readOnly) return journal;
  journal.release();
  throw new Error("The native edit record belongs to another task.");
}

export function verifiedContinuationEdits(journal: Journal) {
  const { approvals, tools, changes, pendingApprovals } = journal.state;
  const completed = new Map(tools.map((tool) => [tool.toolCallId, tool]));
  const approved = new Map(approvals.filter(({ decision }) => decision === "approved").map((approval) => [approval.toolCallId, approval]));
  if (journal.broken || pendingApprovals.length || tools.some(({ state }) => state !== "completed") ||
      [...approved.values()].some(({ toolCallId, toolName, inputDigest }) =>
        completed.get(toolCallId)?.toolName !== toolName || completed.get(toolCallId)?.inputDigest !== inputDigest) ||
      changes.some((change) => {
        const approval = approved.get(change.toolCallId);
        return change.state !== "applied" || !change.directory || change.postimage.identity === undefined ||
          approval?.toolName !== "apply_patch" || !approval.binding.files?.some(({ path, preimage, disk }) =>
            path === change.path && preimage === change.preimage.sha256 && disk && disk.file === change.preimage.identity);
      })) throw new Error("A source edit does not have a verified outcome.");
  const latest = new Map(changes.map((change) => [process.platform === "win32" ? change.path.toLowerCase() : change.path, change]));
  return [...latest.values()].map((change) => {
    if (viewChange(journal, change).current !== "as_written") throw new Error("A source edit changed after it was applied.");
    return { path: change.path, action: change.kind };
  });
}

export function nativePatches(input: {
  directory: string; id: string; project: ProjectRoot; protectedRoots: string[]; model: string; connectionKey: string;
  signal: AbortSignal; resume?: boolean; approve: (view: ApprovalView, signal: AbortSignal) => Promise<boolean>;
}) {
  assertProjectRoot(input.project);
  const home = editsHome(input.directory);
  if ((!input.resume && existsSync(home)) || !same(realpathSync(input.directory), input.directory)) {
    throw new Error("The native edit record already exists or moved.");
  }
  const workspace = new Workspace(input.project.path, input.protectedRoots);
  const endpoint = resolveEndpoint({}, {});
  const journal = input.resume ? openNativeEdits(input.directory, input.id, input.project) : Journal.create(home, {
    workspace: { root: workspace.root }, endpointOrigin: endpoint.origin, endpointBase: endpoint.base,
    keyPrefix: "native-fixture", readOnly: false,
    model: { requested: input.model, pinned: input.model, pinnedFrom: "user", contextWindowTokens: 0, maxOutputTokens: 0 },
    limits: { maxRequests: 0, timeoutMs: DEFAULTS.timeoutMinutes * 60_000, commandTimeoutMs: 0 },
  }, undefined, input.id);
  const tool: NativePatchTool = {
    spec: { type: "function", name: nativePatchName, description: "Propose specific file edits in this project for Desktop approval.",
      inputSchema: z.toJSONSchema(patchSchema) },
    invoke: async (toolCallId, raw, nativeSignal, waitForWrite) => {
      const signal = AbortSignal.any([input.signal, nativeSignal]);
      const reject = { success: false, text: "No approved Desktop file edit was applied." };
      const parsed = patchSchema.safeParse(raw);
      if (!parsed.success || signal.aborted || journal.broken || journal.state.approvals.some((item) => item.toolCallId === toolCallId)) return reject;
      assertProjectRoot(input.project);
      let patch: ReturnType<typeof planPatchCall>;
      try { patch = planPatchCall({ workspace }, parsed.data); }
      catch { return reject; }
      if ([parsed.data.explanation, ...patch.flatMap(({ path, beforeText, afterText }) => [path, beforeText, afterText])]
        .some((value) => value && hasCredential(value, input.connectionKey))) return reject;
      const approval: ApprovalView = { approvalId: toolCallId, toolCallId, toolName: "apply_patch", input: parsed.data,
        explanation: parsed.data.explanation, patch, root: workspace.root };
      const stillMatchesPreview = () => {
        try {
          assertProjectRoot(input.project);
          for (const edit of patch) assertBoundFile(workspace, edit.path, edit.absolute, edit.binding, edit.preimage);
          return true;
        } catch {
          return false;
        }
      };
      const changed = { success: false, text: `${reject.text} The project or files changed after the preview.` };
      const approved = await input.approve(approval, signal);
      if (signal.aborted || !approved) return reject;
      if (!stillMatchesPreview()) return changed;
      if (waitForWrite) {
        if (!await waitForWrite(approval, signal) || signal.aborted) return reject;
        if (!stillMatchesPreview()) return changed;
      }
      journal.state.approvals.push({
        approvalId: toolCallId, toolCallId, toolName: "apply_patch", inputDigest: canonicalDigest(parsed.data), decision: "approved", decidedAt: new Date().toISOString(),
        binding: { files: patch.map(({ path, preimage, binding }) => ({ path, preimage, disk: binding })) },
      });
      journal.commit();
      const context: ToolContext = {
        workspace, journal, signal: () => signal, assertAllowed: () => assertProjectRoot(input.project),
        readByteLimit: 0, commandTimeoutMs: 0, commandEnv: [], onActivity: () => {}, onCommandOutput: () => {},
      };
      const execute = createTools(context, false).apply_patch.execute;
      const result = resultSchema.parse(await execute?.(parsed.data, { toolCallId, messages: [], context: undefined, abortSignal: signal }));
      return result.status === "ok" ? { success: true, text: "The approved Desktop patch was verified on disk." }
        : { success: false, text: "Check the current files before proposing another edit." };
    },
  };
  return { journal, tool };
}
