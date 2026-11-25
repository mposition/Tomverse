import { randomUUID } from "node:crypto";
import type { Language } from "../../../../lib/language";
import { desktopCodeReviewCopy } from "../../../../locales/desktopCodeReview";
import type { Change } from "../contract";
import { MAX_REVIEW_DIFF_CHARACTERS, REVIEW_REQUESTS, reviewInput, type ReviewDiff, type ReviewFile, type ReviewHunk, type ReviewInput, type ReviewOutcome, type ReviewScope, type ReviewUnavailable } from "../review-contract";
import { mergeReviewResults } from "../review-findings";
import type { Connection, RecordedSession, WorkerCommand, WorkerEvent } from "./messages";
import type { ProjectRoot } from "./project-root";
import { reviewDiffText } from "./review-diff";
import { readScopeDiff, type ScopeDiffResult } from "./review-git";

/**
 * The `desktop:review` IPC handler. The renderer sends an action and typed ids; this module recomputes the diff itself, finds the
 * hunk or the models the ids name, asks the person in a native dialog before anything is written or sent, and only then gives the
 * Code runtime process a command. main.ts supplies what it owns (the selected task, whether the app is idle, the dialogs).
 */

export type ReviewTarget = {
  taskId: string;
  /** The saved task's record, with the project the files are in (a Code worktree's checkout, or the opened folder). */
  record: Omit<RecordedSession, "requestId">;
  /** Where a Code worktree was started from. */
  worktreeBase?: { ref: string; commit: string };
};

export type ReviewWorkerCommand = Extract<WorkerCommand, { type: "review-turn-diff" | "review-revert-hunk" | "review-run" }>;

export type ReviewHostDeps = {
  /** The saved Tomverse API task the panel is for, or null. */
  target(): ReviewTarget | null;
  /** Nothing is running, waiting for an answer or being changed, so a write or a paid run may start. */
  ready(): boolean;
  /** The Code model catalogue the reviewers are chosen from. */
  models(): Array<{ id: string; name: string }>;
  connection(): Connection | null;
  protectedRoot(): string;
  language(): Language;
  request(command: ReviewWorkerCommand, timeoutMs: number): Promise<WorkerEvent | "unconfirmed" | "unavailable">;
  confirm(copy: { title: string; message: string; detail: string; accept: string; cancel: string }): Promise<boolean>;
  cancel(requestId: string): void;
  afterRevert(taskId: string, changes: Change[]): void;
  readScope?: (project: ProjectRoot, scope: "uncommitted" | "branch", options: { base?: string; worktreeBase?: { ref: string; commit: string } }) => Promise<ScopeDiffResult>;
  newId?: () => string;
};

type DiffResult = { status: "ok"; diff: ReviewDiff } | { status: "unavailable"; reason: ReviewUnavailable };
const REVIEW_TIMEOUT_MS = 15 * 60_000;

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{([a-z]+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
const oneLine = (text: string) => text.replaceAll(/[\r\n]+/g, " ⏎ ").slice(0, 300);

export function findHunk(diff: ReviewDiff, id: string): { file: ReviewFile; hunk: ReviewHunk } | null {
  for (const file of diff.files) {
    if (file.omitted) continue;
    const hunk = file.hunks.find((item) => item.id === id);
    if (hunk) return { file, hunk };
  }
  return null;
}

export function createReviewActions(deps: ReviewHostDeps) {
  const readScope = deps.readScope ?? readScopeDiff;
  const newId = deps.newId ?? randomUUID;
  let exclusive = false;
  let running: { requestId: string } | null = null;

  async function computeDiff(scope: ReviewScope, base: string | undefined, target: ReviewTarget): Promise<DiffResult> {
    if (scope !== "last-turn") return readScope(target.record.project, scope, { base, worktreeBase: target.worktreeBase });
    if (!deps.ready()) return { status: "unavailable", reason: "busy" };
    const event = await deps.request({ type: "review-turn-diff", requestId: newId(), ...target.record, protectedRoot: deps.protectedRoot() }, 15_000);
    if (typeof event === "string" || event.type !== "review-turn") return { status: "unavailable", reason: event === "unavailable" ? "busy" : "failed" };
    return event.diff ? { status: "ok", diff: event.diff } : { status: "unavailable", reason: event.reason === "no-turn" ? "no-turn" : "failed" };
  }

  // The same task, still idle, after the person was asked something.
  const stillHolds = (target: ReviewTarget) => deps.ready() && deps.target()?.taskId === target.taskId;

  async function revertHunk(input: Extract<ReviewInput, { action: "revert-hunk" }>, target: ReviewTarget): Promise<ReviewOutcome<"revert-hunk">> {
    if (!deps.ready()) return { status: "unavailable" };
    const found = await computeDiff(input.scope, input.base, target);
    if (found.status !== "ok") return { status: "unavailable" };
    const match = findHunk(found.diff, input.hunkId);
    // The diff is read again for every revert: a hunk that is not in it now is not the one the person saw.
    if (!match) return { status: "stale" };
    const copy = desktopCodeReviewCopy[deps.language()];
    const added = match.hunk.lines.filter((line) => line.kind === "add").length;
    const removed = match.hunk.lines.filter((line) => line.kind === "remove").length;
    const accepted = await deps.confirm({
      title: copy.dialogRevertTitle, message: copy.dialogRevertMessage, accept: copy.dialogRevertAccept, cancel: copy.dialogCancel,
      detail: fill(copy.dialogRevertDetail, { path: oneLine(match.file.path), header: match.hunk.header, added, removed }),
    });
    if (!accepted) return { status: "cancelled" };
    if (!stillHolds(target)) return { status: "unavailable" };
    const event = await deps.request({
      type: "review-revert-hunk", requestId: newId(), ...target.record, protectedRoot: deps.protectedRoot(),
      path: match.file.path, status: match.file.status, hunk: match.hunk,
    }, 20_000);
    if (event === "unconfirmed") return { status: "unconfirmed" };
    if (event === "unavailable" || event.type !== "review-reverted") return { status: "unavailable" };
    if (event.result === "reverted" && event.changes) deps.afterRevert(target.taskId, event.changes);
    return { status: event.result };
  }

  async function run(input: Extract<ReviewInput, { action: "run" }>, target: ReviewTarget): Promise<ReviewOutcome<"run">> {
    const connection = deps.connection();
    const catalogue = deps.models();
    const models = input.modelIds.map((id) => catalogue.find((model) => model.id === id));
    if (!connection || !deps.ready() || models.some((model) => !model)) return { status: "unavailable" };
    const chosen = models as Array<{ id: string; name: string }>;
    const found = await computeDiff(input.scope, input.base, target);
    if (found.status !== "ok") return { status: "unavailable" };
    if (!found.diff.files.some((file) => file.hunks.length)) return { status: "empty" };
    const text = reviewDiffText(found.diff, MAX_REVIEW_DIFF_CHARACTERS);
    const copy = desktopCodeReviewCopy[deps.language()];
    const accepted = await deps.confirm({
      title: copy.dialogRunTitle, accept: copy.dialogRunAccept, cancel: copy.dialogCancel,
      message: fill(copy.dialogRunMessage, { count: chosen.length }),
      detail: fill(copy.dialogRunDetail, { models: chosen.map((model) => oneLine(model.name)).join(", "), requests: REVIEW_REQUESTS }),
    });
    if (!accepted) return { status: "cancelled" };
    if (!stillHolds(target)) return { status: "unavailable" };
    const requestId = newId();
    running = { requestId };
    try {
      const event = await deps.request({
        type: "review-run", requestId, project: target.record.project, connection, protectedRoot: deps.protectedRoot(),
        scope: input.scope, diffText: text.text, truncated: text.truncated, models: chosen,
      }, REVIEW_TIMEOUT_MS);
      if (event === "unconfirmed") return { status: "unconfirmed" };
      if (event === "unavailable" || event.type !== "review-finished") return { status: "unavailable" };
      if (event.status === "cancelled") return { status: "cancelled" };
      if (event.status !== "done") return { status: "unavailable" };
      return { status: "done", results: event.results, findings: mergeReviewResults(event.results) };
    } finally {
      running = null;
    }
  }

  return async function review(value: unknown): Promise<ReviewOutcome> {
    const input = reviewInput.parse(value);
    if (input.action === "cancel") {
      if (running) deps.cancel(running.requestId);
      return { status: "ok" };
    }
    const target = deps.target();
    if (!target) return input.action === "diff" ? { status: "unavailable", reason: "no-task" } : { status: "unavailable" };
    if (input.action === "diff") return computeDiff(input.scope, input.base, target);
    if (exclusive) return { status: "unavailable" };
    exclusive = true;
    try { return input.action === "revert-hunk" ? await revertHunk(input, target) : await run(input, target); }
    finally { exclusive = false; }
  };
}
