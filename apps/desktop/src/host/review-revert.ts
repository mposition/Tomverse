import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { sha256, type Journal, type Workspace } from "../../../tomverse-cli/src/runtime.js";
import { pathIdentity, type FileBinding, type PlannedEdit } from "../../../tomverse-cli/src/patch.js";
import { applyPlannedPatch, type ToolContext } from "../../../tomverse-cli/src/tools.js";
import type { ReviewFile, ReviewHunk } from "../review-contract";
import { MAX_REVIEW_FILES, diffTexts, omittedFile, planHunkRevert } from "./review-diff";

/**
 * Taking one hunk of the diff back out of the working tree. The write goes through the same recorded edit as an agent
 * patch: the file's earlier bytes are kept in the task's journal and the change appears in the task's list, so the
 * existing undo puts the hunk back. It is refused, never forced, when the file no longer has the hunk where the diff said.
 */

export type HunkRevertCommand = { path: string; status: ReviewFile["status"]; hunk: Pick<ReviewHunk, "newStart" | "newCount" | "lines"> };
export type HunkRevertResult = "reverted" | "stale" | "unsupported" | "unconfirmed" | "failed";

function binding(absolute: string): FileBinding {
  let folder = dirname(absolute);
  let directory = pathIdentity(folder, "directory");
  while (directory === null && dirname(folder) !== folder) {
    folder = dirname(folder);
    directory = pathIdentity(folder, "directory");
  }
  if (directory === null) throw new Error("The file's folder is unavailable.");
  return { file: pathIdentity(absolute, "file"), folder, directory };
}

const eolOf = (text: string): PlannedEdit["eol"] => {
  const crlf = text.includes("\r\n");
  const loneLf = /(^|[^\r])\n/.test(text);
  return crlf && loneLf ? "mixed" : crlf ? "crlf" : loneLf ? "lf" : "none";
};

export function revertHunkInJournal(journal: Journal, workspace: Workspace, command: HunkRevertCommand, assertAllowed: () => void): HunkRevertResult {
  assertAllowed();
  const resolved = workspace.resolve(command.path, "write");
  const before = resolved.exists ? readFileSync(resolved.absolute) : null;
  const plan = planHunkRevert(before, command);
  if (!plan.ok) return plan.reason;
  const afterBytes = plan.text === null ? null : Buffer.from(plan.text, "utf8");
  const beforeText = before === null ? null : before.toString("utf8");
  const planned: PlannedEdit = {
    path: resolved.relative, absolute: resolved.absolute, action: plan.action,
    preimage: before ? sha256(before) : null, beforeText, afterText: plan.text, afterBytes,
    postimage: afterBytes ? sha256(afterBytes) : null,
    eol: eolOf(plan.text ?? beforeText ?? ""), bom: (plan.text ?? beforeText ?? "").startsWith("﻿"),
    binding: binding(resolved.absolute),
  };
  const context: ToolContext = {
    readByteLimit: 0, workspace, journal, commandTimeoutMs: 0, commandEnv: [], signal: () => new AbortController().signal,
    assertAllowed, beforeWrite: assertAllowed, onActivity: () => undefined, onCommandOutput: () => undefined,
  };
  const result = applyPlannedPatch(context, `review-${randomBytes(4).toString("hex")}`, [planned]);
  const status = result.files[0]?.status;
  return status === "applied" ? "reverted" : status === "unconfirmed" ? "unconfirmed" : "failed";
}

// ---- the last turn ----------------------------------------------------------------------------

const MAX_TURN_FILE_BYTES = 1_000_000;

const readText = (bytes: Buffer): string | null => {
  if (bytes.length > MAX_TURN_FILE_BYTES || bytes.subarray(0, 8192).includes(0)) return null;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
};

/**
 * What the agent's last turn changed, as it is now: for every file the turn wrote, the content the first of its writes found
 * against the content on disk. A write that was undone leaves nothing to show; a file the person edited since shows that too.
 */
export function lastTurnFiles(journal: Journal, workspace: Workspace): ReviewFile[] | null {
  const { checkpoints = [], changes } = journal.state;
  const mark = checkpoints.at(-1);
  if (!mark) return null;
  const first = new Map<string, (typeof changes)[number]>();
  for (const change of changes.slice(mark.changeStart)) {
    if (change.state !== "applied") continue;
    const key = change.path.replaceAll("\\", "/");
    if (!first.has(key)) first.set(key, change);
  }
  const files: ReviewFile[] = [];
  for (const [path, change] of [...first].slice(0, MAX_REVIEW_FILES)) {
    let before: string | null = null;
    if (change.preimage.sha256 !== null) {
      const bytes = change.preimage.backup ? journal.readBackup(change.preimage.backup) : null;
      const text = bytes && sha256(bytes) === change.preimage.sha256 ? readText(bytes) : null;
      if (text === null) { files.push(omittedFile(path, "unreadable")); continue; }
      before = text;
    }
    let after: string | null = null;
    try {
      const resolved = workspace.resolve(change.path, "read");
      if (resolved.exists) {
        after = readText(readFileSync(resolved.absolute));
        if (after === null) { files.push(omittedFile(path, "binary")); continue; }
      }
    } catch { files.push(omittedFile(path, "unreadable")); continue; }
    if (before === after) continue;
    files.push(diffTexts(path, before, after));
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
