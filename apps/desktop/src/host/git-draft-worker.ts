import { Workspace, type Gateway } from "../../../tomverse-cli/src/runtime.js";
import { assertProjectRoot, type ProjectRoot } from "./project-root";
import type { Connection, WorkerCommand, WorkerEvent } from "./messages";
import { cleanText } from "./journal-view";
import { buildDraftPrompt, DRAFT_REQUESTS } from "./git-draft";
import { runReadOnlyAsk } from "./review-run";

/**
 * The Git draft the Code runtime process answers: one read-only Ask run of one model (review-run.ts), never while a task runs.
 * The runtime hands in what only it owns: the project lock, the busy flag and the gateway.
 */
export type GitDraftWorkerDeps = {
  lock(project: ProjectRoot): () => void;
  busy(): boolean;
  /** Marks the process busy with this request; `abort` is what a cancel request calls. Returns the release. */
  hold(requestId: string, abort: AbortController): () => void;
  gateway(connection: Connection, signal?: AbortSignal): Gateway;
  protectedRoots(root: string): string[];
};

export function createGitDraftWorker(deps: GitDraftWorkerDeps) {
  return {
    async run(command: Extract<WorkerCommand, { type: "git-draft" }>): Promise<WorkerEvent> {
      const reply = { type: "git-drafted", requestId: command.requestId } as const;
      if (deps.busy()) return { ...reply, status: "unavailable", text: "" };
      const abort = new AbortController();
      const release = deps.hold(command.requestId, abort);
      let unlock: (() => void) | undefined;
      try {
        unlock = deps.lock(command.project);
        assertProjectRoot(command.project);
        const key = command.connection.key;
        const gateway = deps.gateway(command.connection, abort.signal);
        const catalog = await gateway.models();
        abort.signal.throwIfAborted();
        const workspace = new Workspace(command.project.path, deps.protectedRoots(command.protectedRoot));
        const redactText = (text: string) => cleanText(text, key);
        // Nothing of the diff that is a credential reaches the model.
        const prompt = buildDraftPrompt({ kind: command.kind, diffText: redactText(command.diffText), truncated: command.truncated, base: command.base ?? null });
        const result = await runReadOnlyAsk({
          gateway, receipts: () => deps.gateway(command.connection, AbortSignal.timeout(3_000)), catalog, workspace, model: command.model, prompt,
          signal: abort.signal, assertAllowed: () => assertProjectRoot(command.project), redactText, maxRequests: DRAFT_REQUESTS,
          productName: "Tomverse Code Draft",
        });
        if (result.status === "cancelled" || abort.signal.aborted) return { ...reply, status: "cancelled", text: "" };
        if (result.status !== "ok") return { ...reply, status: "unavailable", text: "", ...(result.usage ? { requests: result.usage.requests } : {}) };
        return { ...reply, status: "done", text: result.text, requests: result.usage.requests };
      } catch {
        return { ...reply, status: abort.signal.aborted ? "cancelled" : "unavailable", text: "" };
      } finally {
        unlock?.();
        release();
      }
    },
  };
}
