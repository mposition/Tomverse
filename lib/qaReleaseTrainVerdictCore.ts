/**
 * Whether a next-train candidate still needs releasing (owner, 2026-10-29):
 * Admin listed pull requests as "can ride" that main already carried under
 * another commit, and gave the operator nothing to judge the rest by.
 *
 * Two layers. The content check compares the candidate's own change with
 * main and develop as files, free and deterministic: what it added that main
 * lacks but develop still has, and what it removed that main still has but
 * develop no longer does. Nothing missing reads as on main. What is left goes
 * to the model (lib/qaReleaseTrainVerdict.ts), which says whether that
 * difference still needs a release and why, citing only pull requests it was
 * shown. Display only: neither layer picks, hides or releases anything, and
 * the train still checks its own picks at departure.
 */

/**
 * A file whose change main is not proven to hold: the added and removed lines
 * of each hunk not found in place. `binary`: a file with no hunk to read
 * (binary, or a mode change). `changedSince`: develop no longer holds some of
 * those hunks either. `modeDiffers`: main's file lacks the mode the candidate set.
 */
export type QaReleaseTrainGapFile = { path: string; missing: string[]; leftOnMain: string[]; binary?: boolean; changedSince?: boolean; modeDiffers?: boolean };

export type QaReleaseTrainContentVerdict =
  | { state: "on_main"; lines: number }
  | {
      state: "differs";
      lines: number;
      /** Added lines of the hunks main is not proven to hold. */
      missing: number;
      /** Removed lines of those hunks. */
      leftOnMain: number;
      /** The files with a difference, most first, at most QA_RELEASE_TRAIN_VERDICT_FILES. */
      files: { path: string; lines: number }[];
      fileCount: number;
    }
  | { state: "unread" };

export type QaReleaseTrainModelDecision = "release" | "not_needed" | "operator";
export type QaReleaseTrainModelVerdict = {
  decision: QaReleaseTrainModelDecision;
  why: { ko: string; en: string };
  /** Pull requests the answer rests on, each one the model was shown. */
  evidence: number[];
};

export type QaReleaseTrainVerdict = {
  number: number;
  content: QaReleaseTrainContentVerdict;
  /** Main's head this candidate was checked against, and when: one checked against an older main is checked again. */
  mainSha?: string;
  checkedAt?: string;
  /** The content difference the model judged, so the same difference is never asked twice. */
  gapDigest?: string;
  model?: QaReleaseTrainModelVerdict;
  /** When the model was last asked about this difference without an answer. */
  askedAt?: string;
};

export const QA_RELEASE_TRAIN_VERDICT_FILES = 8;
export const QA_RELEASE_TRAIN_VERDICT_WHY_CHARS = 300;
export const QA_RELEASE_TRAIN_VERDICT_EVIDENCE_MAX = 8;

/** One hunk of a file's diff: its pre-image and post-image (context in order), and its own removed and added lines. */
export type QaReleaseTrainDiffHunk = { before: string[]; after: string[]; removed: string[]; added: string[] };

/**
 * The hunks of one file's unified diff, every line exactly as written:
 * indentation and blank lines can be the change itself (Python, a template
 * literal). Everything before the first `@@` is the file's header; a line
 * inside a hunk is read by its first character only, so text that looks
 * like a header is never one.
 */
export function qaReleaseTrainDiffHunks(diff: string): QaReleaseTrainDiffHunk[] {
  const hunks: QaReleaseTrainDiffHunk[] = [];
  let current: QaReleaseTrainDiffHunk | null = null;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      current = { before: [], after: [], removed: [], added: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    const line = raw.slice(1);
    if (raw.startsWith(" ")) {
      current.before.push(line);
      current.after.push(line);
    } else if (raw.startsWith("+")) {
      current.after.push(line);
      current.added.push(line);
    } else if (raw.startsWith("-")) {
      current.before.push(line);
      current.removed.push(line);
    }
  }
  return hunks;
}

/** Where `block` next appears in `lines` as one unbroken run, from `from` on: the index just past it, or -1. */
function findBlock(lines: readonly string[], block: readonly string[], from: number): number {
  outer: for (let start = from; start + block.length <= lines.length; start++) {
    for (let offset = 0; offset < block.length; offset++) if (lines[start + offset] !== block[offset]) continue outer;
    return start + block.length;
  }
  return -1;
}

/**
 * One changed file as the git port reads it: the file the candidate left,
 * main's and develop's now (each `<mode> <blob>`, so a mode change is a
 * change), their text, and the candidate's own diff of the file (`-U3`, read
 * for this path alone, so no path is ever parsed out of a diff header).
 * `post` is null for a file the candidate deleted; a side is null where the
 * file does not exist.
 */
export type QaReleaseTrainChangedFile = {
  path: string;
  post: string | null;
  main: string | null;
  develop: string | null;
  binary: boolean;
  diff?: string;
  mainText?: string | null;
  developText?: string | null;
};

/**
 * The content check of one candidate. A wrong "on main" would hide a release
 * the operator needs, so "on main" is only what is proven; everything else is
 * a difference for the model and the operator to judge:
 *
 * - a file main holds exactly as the candidate left it, or exactly as
 *   develop holds it now (whatever develop did with the change since, main
 *   has nothing of this file left to receive), is on main;
 * - otherwise each hunk is on main only when its whole post-image -- its
 *   context and added lines, in order -- is in main, after the place the
 *   file's previous hunk was found: one run of main's lines never stands for
 *   two hunks. A hunk that is not leaves its added and removed lines
 *   unconfirmed, marked when develop no longer holds that post-image either
 *   (develop changed the spot since);
 * - lines compare exactly, whitespace and blank lines included; a diff that
 *   touches a file's final newline leaves the file unconfirmed whole;
 * - a file the candidate deleted is on main only where main has no such
 *   path (an empty file is not a deleted one), and a file it left is not on
 *   a main that has no such path (an empty file is not a missing one);
 * - a mode the candidate set that main's file lacks is unconfirmed, whatever
 *   its text;
 * - a binary file, or one whose diff has no hunk (a mode change), that
 *   matches neither is unconfirmed whole.
 */
export function qaReleaseTrainContentGap(changed: readonly QaReleaseTrainChangedFile[]): { verdict: QaReleaseTrainContentVerdict; gap: QaReleaseTrainGapFile[] } {
  const gap: QaReleaseTrainGapFile[] = [];
  let counted = 0;
  // A file's lines exactly; the newline that ends the last line starts no line of its own.
  const lines = (text: string | null | undefined) => {
    if (typeof text !== "string" || text === "") return [];
    const all = text.split("\n");
    return all[all.length - 1] === "" ? all.slice(0, -1) : all;
  };
  const mode = (side: string | null) => side?.split(" ")[0] ?? null;
  for (const file of changed) {
    const hunks = file.binary ? [] : qaReleaseTrainDiffHunks(file.diff ?? "");
    counted += hunks.length === 0 ? 1 : hunks.reduce((sum, hunk) => sum + hunk.added.length + hunk.removed.length, 0);
    if (file.main === file.post || file.main === file.develop) continue;
    // Deleted by the candidate, still a path on main (main without it returned above).
    if (file.post === null) {
      gap.push({ path: file.path, missing: [], leftOnMain: hunks.flatMap((hunk) => hunk.removed), ...(hunks.length === 0 ? { binary: true } : {}) });
      continue;
    }
    if (hunks.length === 0) {
      gap.push({ path: file.path, missing: [], leftOnMain: [], binary: true });
      continue;
    }
    // Left by the candidate but not a path on main, or its final newline changed: unconfirmed whole.
    if (file.main === null || /^\\/m.test(file.diff ?? "")) {
      gap.push({ path: file.path, missing: hunks.flatMap((hunk) => hunk.added), leftOnMain: hunks.flatMap((hunk) => hunk.removed) });
      continue;
    }
    const main = lines(file.mainText);
    const develop = lines(file.developText);
    // An empty post-image (the file emptied) is only "found" in a file with nothing left.
    const find = (side: readonly string[], block: readonly string[], from: number) =>
      block.length === 0 ? (side.length === 0 ? from : -1) : findBlock(side, block, from);
    const missing: string[] = [];
    const leftOnMain: string[] = [];
    let changedSince = false;
    let cursor = 0;
    for (const hunk of hunks) {
      if (hunk.added.length === 0 && hunk.removed.length === 0) continue;
      const found = find(main, hunk.after, cursor);
      if (found >= 0) {
        cursor = found;
        continue;
      }
      missing.push(...hunk.added);
      leftOnMain.push(...hunk.removed);
      if (find(develop, hunk.after, 0) < 0) changedSince = true;
    }
    const modeDiffers = mode(file.main) !== mode(file.post);
    if (missing.length > 0 || leftOnMain.length > 0 || modeDiffers) {
      gap.push({ path: file.path, missing, leftOnMain, ...(changedSince ? { changedSince } : {}), ...(modeDiffers ? { modeDiffers } : {}) });
    }
  }
  if (gap.length === 0) return { verdict: { state: "on_main", lines: counted }, gap };
  const size = (file: QaReleaseTrainGapFile) => (file.binary ? 1 : file.missing.length + file.leftOnMain.length || 1);
  const sorted = [...gap].sort((a, b) => size(b) - size(a) || a.path.localeCompare(b.path));
  return {
    verdict: {
      state: "differs",
      lines: counted,
      missing: gap.reduce((sum, file) => sum + (file.binary ? 1 : file.missing.length), 0),
      leftOnMain: gap.reduce((sum, file) => sum + file.leftOnMain.length, 0),
      files: sorted.slice(0, QA_RELEASE_TRAIN_VERDICT_FILES).map((file) => ({ path: file.path, lines: size(file) })),
      fileCount: gap.length,
    },
    gap: sorted,
  };
}

/** The text the gap digest is taken over: every file and line, in a fixed order. */
export const qaReleaseTrainGapText = (gap: readonly QaReleaseTrainGapFile[]) =>
  JSON.stringify([...gap].sort((a, b) => a.path.localeCompare(b.path)).map((file) => [file.path, Boolean(file.binary), Boolean(file.changedSince), Boolean(file.modeDiffers), file.missing, file.leftOnMain]));

/* ------------------------------------------------------------------------- */
/* The model's judgement of a difference                                     */
/* ------------------------------------------------------------------------- */

export type QaReleaseTrainVerdictQuestion = {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  verdict: Extract<QaReleaseTrainContentVerdict, { state: "differs" }>;
  gap: readonly QaReleaseTrainGapFile[];
  /** Main pull requests that touched the differing files after it, or that mention it. */
  mainPulls: readonly { number: number; title: string; body: string }[];
};

/** What one question may carry; a larger one is cut, file by file. */
export const QA_RELEASE_TRAIN_VERDICT_MAX_INPUT_CHARS = 120_000;
const LINES_PER_FILE = 60;
const BODY_CHARS = 6_000;
const MAIN_BODY_CHARS = 5_000;

export const QA_RELEASE_TRAIN_VERDICT_SYSTEM = [
  "You decide whether a develop pull request still needs releasing to main (production) in a web app's release train.",
  "A content check looked for each hunk of its change in main, whole and in place: you get the hunks main is not proven to hold, as their added (+) and removed (-) lines. A file marked 'develop changed since' means develop no longer holds some of those hunks as written either: a later pull request changed that spot.",
  "Answer `release` when main lacks a change of this pull request that should reach production.",
  "Answer `not_needed` when what main lacks does not need releasing: only comments or wording, a record or document kept on develop, a file generated for develop, something main got in another form, or a change a main release deliberately left out (say which).",
  "Answer `operator` when the evidence does not settle it.",
  "`evidence`: the numbers of the pull requests your answer rests on, only ones given to you.",
  "`why_ko` (Korean) and `why_en` (English): the same one or two plain sentences an operator reads to decide, naming the deciding fact.",
].join("\n");

export const QA_RELEASE_TRAIN_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["release", "not_needed", "operator"] },
    why_ko: { type: "string" },
    why_en: { type: "string" },
    evidence: { type: "array", items: { type: "integer" } },
  },
  required: ["decision", "why_ko", "why_en", "evidence"],
  additionalProperties: false,
};

/** The question the model sees, inside QA_RELEASE_TRAIN_VERDICT_MAX_INPUT_CHARS. */
export function qaReleaseTrainVerdictPrompt(question: QaReleaseTrainVerdictQuestion): string {
  const head = [
    `Develop pull request #${question.number}: ${question.title}`,
    `Merged into develop: ${question.mergedAt}`,
    "",
    "Its description:",
    question.body.slice(0, BODY_CHARS) || "(none)",
    "",
    `Content check: ${question.verdict.missing} added and ${question.verdict.leftOnMain} removed line(s) not proven on main, in ${question.verdict.fileCount} file(s), out of ${question.verdict.lines} changed line(s).`,
  ];
  const pulls = question.mainPulls.length
    ? ["", "Main pull requests that touched these files after it, or mention it:", ...question.mainPulls.flatMap((pull) => ["", `#${pull.number}: ${pull.title}`, pull.body.slice(0, MAIN_BODY_CHARS)])]
    : ["", "No main pull request touched these files after it or mentions it."];
  let budget = QA_RELEASE_TRAIN_VERDICT_MAX_INPUT_CHARS - head.join("\n").length - pulls.join("\n").length;
  const files: string[] = [""];
  for (const file of question.gap) {
    const part = [
      `File: ${file.path}`,
      ...(file.binary ? ["(no text to compare: binary, or a mode change; main's file differs)"] : []),
      ...(file.changedSince ? ["(develop changed since)"] : []),
      ...(file.modeDiffers ? ["(main's file lacks the file mode this pull request set)"] : []),
      ...file.missing.slice(0, LINES_PER_FILE).map((line) => `+ ${line}`),
      ...(file.missing.length > LINES_PER_FILE ? [`+ ... ${file.missing.length - LINES_PER_FILE} more`] : []),
      ...file.leftOnMain.slice(0, LINES_PER_FILE).map((line) => `- ${line}`),
      ...(file.leftOnMain.length > LINES_PER_FILE ? [`- ... ${file.leftOnMain.length - LINES_PER_FILE} more`] : []),
    ].join("\n");
    if (part.length + 1 > budget) {
      files.push(`(${question.gap.length - (files.length - 1)} more file(s) not shown)`);
      break;
    }
    budget -= part.length + 1;
    files.push(part);
  }
  return [...head, "", "Not proven on main (+ added, - removed):", ...files, ...pulls].join("\n");
}

const clean = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, QA_RELEASE_TRAIN_VERDICT_WHY_CHARS) : "");

/**
 * The model's answer checked: a known decision, a reason in both languages,
 * and evidence only from the pull requests it was shown. An answer citing
 * one it was not shown is not trusted and reads as the operator's call.
 */
export function qaReleaseTrainModelVerdictFrom(answer: unknown, shown: readonly number[]): QaReleaseTrainModelVerdict | null {
  const value = answer as { decision?: unknown; why_ko?: unknown; why_en?: unknown; evidence?: unknown } | null;
  if (typeof value !== "object" || value === null) return null;
  if (value.decision !== "release" && value.decision !== "not_needed" && value.decision !== "operator") return null;
  const ko = clean(value.why_ko);
  const en = clean(value.why_en);
  if (!ko || !en || !Array.isArray(value.evidence)) return null;
  const evidence = [...new Set(value.evidence)];
  if (!evidence.every((n) => Number.isInteger(n) && shown.includes(n as number))) {
    return {
      decision: "operator",
      why: { ko: "모델이 보여 주지 않은 PR을 근거로 들어 판정을 쓰지 않았습니다.", en: "The model cited a pull request it was not shown, so its answer is not used." },
      evidence: [],
    };
  }
  return { decision: value.decision, why: { ko, en }, evidence: (evidence as number[]).slice(0, QA_RELEASE_TRAIN_VERDICT_EVIDENCE_MAX) };
}

/* ------------------------------------------------------------------------- */
/* Admin's view of the verdicts                                              */
/* ------------------------------------------------------------------------- */

export type QaReleaseTrainVerdicts = {
  /** Main's head the content was compared with. */
  mainSha: string;
  at: string;
  verdicts: QaReleaseTrainVerdict[];
};

/**
 * The stored verdicts, or none when the row does not parse. A verdict with a
 * state Admin does not know is dropped, and a model answer that is not whole
 * is dropped from its verdict: the read is as strict as the route's write.
 */
export function qaReleaseTrainVerdictsFrom(value: unknown): QaReleaseTrainVerdicts | null {
  const row = value as Partial<QaReleaseTrainVerdicts> | null;
  if (typeof row !== "object" || row === null || typeof row.mainSha !== "string" || typeof row.at !== "string" || !Array.isArray(row.verdicts)) return null;
  const verdicts: QaReleaseTrainVerdict[] = [];
  for (const item of row.verdicts as unknown[]) {
    const verdict = item as Partial<QaReleaseTrainVerdict> | null;
    if (typeof verdict !== "object" || verdict === null || !Number.isInteger(verdict.number)) continue;
    const content = verdict.content as
      | { state?: unknown; lines?: unknown; missing?: unknown; leftOnMain?: unknown; fileCount?: unknown; files?: unknown }
      | undefined;
    const known =
      content?.state === "unread" ||
      (content?.state === "on_main" && Number.isInteger(content.lines)) ||
      (content?.state === "differs" && Number.isInteger(content.missing) && Number.isInteger(content.leftOnMain) && Number.isInteger(content.fileCount) && Array.isArray(content.files));
    if (!known) continue;
    const model = verdict.model as Partial<QaReleaseTrainModelVerdict> | undefined;
    const whole =
      model !== undefined &&
      (model.decision === "release" || model.decision === "not_needed" || model.decision === "operator") &&
      typeof model.why?.ko === "string" &&
      typeof model.why?.en === "string" &&
      Array.isArray(model.evidence) &&
      model.evidence.every((n) => Number.isInteger(n));
    const kept = { ...(verdict as QaReleaseTrainVerdict) };
    if (!whole) delete kept.model;
    verdicts.push(kept);
  }
  return { mainSha: row.mainSha, at: row.at, verdicts };
}
