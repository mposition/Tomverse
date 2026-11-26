import { Workspace, type Gateway, type Journal } from "../../../tomverse-cli/src/runtime.js";
import type { ReviewDiff } from "../review-contract";
import { assertProjectRoot, type ProjectRoot } from "./project-root";
import type { Connection, WorkerCommand, WorkerEvent } from "./messages";
import { cleanText, journalChanges, journalStatus } from "./journal-view";
import { buildReviewPrompt, runReviewers } from "./review-run";
import { lastTurnFiles, revertHunkInJournal } from "./review-revert";

/**
 * The review commands the Code runtime process answers. The runtime hands in what only it owns: the saved task's journal,
 * the project lock, the busy flag and the gateway. A review or a hunk revert never runs while a task does.
 */
export type ReviewWorkerDeps = {
  open(command: Extract<WorkerCommand, { type: "review-turn-diff" | "review-revert-hunk" }>): Journal | undefined;
  lock(project: ProjectRoot): () => void;
  busy(): boolean;
  /** Marks the process busy with this request; `abort` is what a cancel request calls. Returns the release. */
  hold(requestId: string, abort: AbortController): () => void;
  gateway(connection: Connection, signal?: AbortSignal): Gateway;
  protectedRoots(root: string): string[];
};

export function createReviewWorker(deps: ReviewWorkerDeps) {
  return {
    turnDiff(command: Extract<WorkerCommand, { type: "review-turn-diff" }>): WorkerEvent {
      const reply = { type: "review-turn", requestId: command.requestId } as const;
      if (deps.busy()) return { ...reply, diff: null, reason: "failed" };
      let journal: Journal | undefined;
      try {
        journal = deps.open(command);
        if (!journal || journal.broken) return { ...reply, diff: null, reason: "failed" };
        assertProjectRoot(command.project);
        const files = lastTurnFiles(journal, new Workspace(command.project.path, deps.protectedRoots(command.protectedRoot)));
        if (!files) return { ...reply, diff: null, reason: "no-turn" };
        const diff: ReviewDiff = { scope: "last-turn", files };
        return { ...reply, diff };
      } catch {
        return { ...reply, diff: null, reason: "failed" };
      } finally {
        journal?.release();
      }
    },

    revertHunk(command: Extract<WorkerCommand, { type: "review-revert-hunk" }>): WorkerEvent {
      const reply = { type: "review-reverted", requestId: command.requestId } as const;
      if (deps.busy()) return { ...reply, result: "unavailable" };
      let journal: Journal | undefined;
      let unlock: (() => void) | undefined;
      let started = false;
      try {
        unlock = deps.lock(command.project);
        journal = deps.open(command);
        if (!journal || journal.broken || journalStatus(journal.state) === "unknown") return { ...reply, result: "unavailable" };
        const assertAllowed = () => assertProjectRoot(command.project);
        assertAllowed();
        const workspace = new Workspace(command.project.path, deps.protectedRoots(command.protectedRoot));
        started = true;
        const result = revertHunkInJournal(journal, workspace, command, assertAllowed);
        if (result === "reverted") return { ...reply, result, changes: journalChanges(journal.state) };
        return { ...reply, result: result === "stale" ? "stale" : result === "unconfirmed" ? "unconfirmed" : "unavailable" };
      } catch {
        return { ...reply, result: started ? "unconfirmed" : "unavailable" };
      } finally {
        journal?.release();
        unlock?.();
      }
    },

    async run(command: Extract<WorkerCommand, { type: "review-run" }>): Promise<WorkerEvent> {
      const reply = { type: "review-finished", requestId: command.requestId } as const;
      if (deps.busy()) return { ...reply, status: "unavailable", results: [] };
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
        // Nothing of the diff that is a credential reaches a reviewer.
        const prompt = buildReviewPrompt({ scope: command.scope, diffText: redactText(command.diffText), truncated: command.truncated });
        const results = await runReviewers({
          gateway, receipts: () => deps.gateway(command.connection, AbortSignal.timeout(3_000)), catalog, workspace, models: command.models, prompt,
          signal: abort.signal, assertAllowed: () => assertProjectRoot(command.project), redactText,
        });
        return { ...reply, status: abort.signal.aborted ? "cancelled" : "done", results };
      } catch {
        return { ...reply, status: abort.signal.aborted ? "cancelled" : "unavailable", results: [] };
      } finally {
        unlock?.();
        release();
      }
    },
  };
}
