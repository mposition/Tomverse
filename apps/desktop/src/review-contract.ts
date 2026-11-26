import { z } from "zod";

/**
 * The Desktop review panel and the review command. The renderer names an action and typed ids;
 * the main process recomputes the diff itself and maps a hunk id back to a file, so no file path
 * crosses the bridge from the renderer. Everything here is free of Node and Electron imports so
 * the renderer can share the types and the pure helpers.
 */

export const reviewScope = z.enum(["uncommitted", "last-turn", "branch"]);
export type ReviewScope = z.infer<typeof reviewScope>;

/** Models one review may use at once (cross review), and the longest comment the panel keeps. */
export const MAX_REVIEW_MODELS = 4;
export const MAX_REVIEW_COMMENT_CHARACTERS = 2_000;
/** Longest diff text one reviewer is sent; the rest is left out and the reviewer is told so. */
export const MAX_REVIEW_DIFF_CHARACTERS = 120_000;
/** Model requests one reviewer may use (reading files for context, then the answer). */
export const REVIEW_REQUESTS = 8;

const hunkId = z.string().regex(/^[0-9a-f]{16}$/);
const baseRef = z.string().regex(/^refs\/heads\/[\w./-]{1,200}$/).max(240)
  .refine((ref) => !ref.includes("..") && !ref.includes("//") && !ref.includes("/.") && !/[/.]$/.test(ref));
const modelId = z.string().min(1).max(240);

export const reviewInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("diff"), scope: reviewScope, base: baseRef.optional() }).strict(),
  z.object({ action: z.literal("revert-hunk"), scope: reviewScope, base: baseRef.optional(), hunkId }).strict(),
  z.object({
    action: z.literal("run"), scope: reviewScope, base: baseRef.optional(),
    modelIds: z.array(modelId).min(1).max(MAX_REVIEW_MODELS).refine((ids) => new Set(ids).size === ids.length),
  }).strict(),
  z.object({ action: z.literal("cancel") }).strict(),
]);
export type ReviewInput = z.infer<typeof reviewInput>;
export type ReviewAction = ReviewInput["action"];

export type ReviewLine = {
  kind: "context" | "add" | "remove";
  text: string;
  oldNo?: number;
  newNo?: number;
  /** The file has no line ending after this line (git's "No newline at end of file"). */
  noEol?: true;
};
export type ReviewHunk = {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ReviewLine[];
};
export type ReviewFile = {
  id: string;
  path: string;
  status: "modified" | "added" | "deleted";
  added: number;
  removed: number;
  hunks: ReviewHunk[];
  /** Why there are no lines to show or to revert. */
  omitted?: "binary" | "large" | "secret" | "unreadable";
};
export type ReviewDiff = {
  scope: ReviewScope;
  files: ReviewFile[];
  /** More files or lines existed than the panel keeps. */
  truncated?: true;
  /** The branch scope: what it was compared with and the branches that can be chosen instead. */
  base?: { ref: string; label: string };
  bases?: Array<{ ref: string; label: string }>;
};

export type ReviewUnavailable = "no-task" | "busy" | "not-git" | "git-unavailable" | "no-turn" | "no-base" | "failed";

export const reviewSeverity = z.enum(["critical", "high", "medium", "low", "info"]);
export type ReviewSeverity = z.infer<typeof reviewSeverity>;
export const SEVERITY_ORDER: readonly ReviewSeverity[] = ["critical", "high", "medium", "low", "info"];

export const reviewFinding = z.object({
  file: z.string().trim().min(1).max(1_024),
  line: z.int().positive().max(10_000_000).nullish().transform((value) => value ?? null),
  endLine: z.int().positive().max(10_000_000).nullish().transform((value) => value ?? null),
  severity: reviewSeverity,
  description: z.string().trim().min(1).max(2_000),
  suggestion: z.string().trim().max(2_000).nullish().transform((value) => value || null),
});
export type ReviewFinding = z.infer<typeof reviewFinding>;

/** One model's review as the worker returns it. `failed` and `unparseable` keep the model visible in the list. */
export type ReviewModelResult = {
  modelId: string;
  modelName: string;
  status: "ok" | "failed" | "unparseable" | "cancelled";
  summary?: string;
  findings: ReviewFinding[];
  /** Findings the reviewer wrote that did not fit the schema. */
  dropped?: number;
  requests?: number;
  credits?: { settled: number; held: number; unknown: number };
};
/** The findings of every model in one list; `models` names each model that reported the same thing. */
export type MergedFinding = ReviewFinding & { id: string; models: string[] };

export type ReviewOutcome<Action extends ReviewAction = ReviewAction> = {
  diff: { status: "ok"; diff: ReviewDiff } | { status: "unavailable"; reason: ReviewUnavailable };
  "revert-hunk": { status: "reverted" | "cancelled" | "stale" | "unavailable" | "unconfirmed" };
  run: { status: "done"; results: ReviewModelResult[]; findings: MergedFinding[] } |
    { status: "empty" | "cancelled" | "unavailable" | "unconfirmed" };
  cancel: { status: "ok" };
}[Action];

export const normalizeReviewPath = (path: string) => path.trim().replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");

// ---- the review command ----------------------------------------------------------------------

export const REVIEW_OPEN_EVENT = "tomverse-review-open";
const scopeWords: Record<string, ReviewScope> = {
  uncommitted: "uncommitted", changes: "uncommitted", working: "uncommitted",
  turn: "last-turn", "last-turn": "last-turn", last: "last-turn",
  branch: "branch",
};

/** `/review`, `/review turn`, `/review branch`: the instruction is a command for the app, not text for the agent. */
export function parseReviewCommand(text: string): { scope: ReviewScope | null } | null {
  const match = /^\/review(?:[ \t]+(\S+))?[ \t]*$/i.exec(text.trim());
  if (!match) return null;
  return { scope: match[1] ? scopeWords[match[1].toLowerCase()] ?? null : null };
}

// ---- comments and findings as the next instruction ---------------------------------------------

export type ReviewComment = {
  path: string;
  startLine: number;
  endLine: number;
  /** Which side of the diff the line numbers are on: a removed line only exists on the old side. */
  side: "new" | "old";
  snippet: string;
  text: string;
};

const SNIPPET_LINES = 24;
const SNIPPET_CHARACTERS = 2_400;

function fence(code: string) {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(longest + 1);
}

function clip(snippet: string) {
  const lines = snippet.split("\n").slice(0, SNIPPET_LINES);
  const text = lines.join("\n");
  return text.length > SNIPPET_CHARACTERS ? `${text.slice(0, SNIPPET_CHARACTERS)}\n…` : text;
}

/** The comments in the order they were made, each with its file, line range and the code it is about. */
export function serializeReviewComments(comments: readonly ReviewComment[]): string {
  if (!comments.length) return "";
  const blocks = comments.map((comment, index) => {
    const range = comment.endLine > comment.startLine ? `${comment.startLine}-${comment.endLine}` : String(comment.startLine);
    const snippet = clip(comment.snippet);
    const marks = fence(snippet);
    const where = `${normalizeReviewPath(comment.path)}:${range}${comment.side === "old" ? " (removed lines)" : ""}`;
    return `${index + 1}. ${where}\n${marks}\n${snippet}\n${marks}\nComment: ${comment.text.trim()}`;
  });
  return `Review comments on the current changes. Address each one:\n\n${blocks.join("\n\n")}`;
}

/** One finding of a reviewer, written as an instruction for the agent. */
export function serializeFindingForFix(finding: Pick<MergedFinding, "file" | "line" | "endLine" | "severity" | "description" | "suggestion" | "models">): string {
  const where = finding.line === null ? finding.file : `${finding.file}:${finding.line}${finding.endLine && finding.endLine > finding.line ? `-${finding.endLine}` : ""}`;
  return [
    `Fix this review finding (${finding.severity}, reported by ${finding.models.join(", ") || "a reviewer"}):`,
    `${where}`,
    finding.description.trim(),
    ...(finding.suggestion ? [`Suggested direction: ${finding.suggestion.trim()}`] : []),
    "Check that the finding is correct before changing anything.",
  ].join("\n");
}
