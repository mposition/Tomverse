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

/** A line of the candidate's change that main lacks, or still holds after the candidate removed it. */
export type QaReleaseTrainGapFile = { path: string; missing: string[]; leftOnMain: string[]; binary?: boolean };

export type QaReleaseTrainContentVerdict =
  | { state: "on_main"; lines: number }
  | {
      state: "differs";
      lines: number;
      /** Lines the candidate added that develop keeps and main lacks. */
      missing: number;
      /** Lines the candidate removed that main still holds and develop no longer does. */
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

/**
 * Whether a line says enough to be found by itself: a bare `}` or `);` is in
 * nearly every file and proves nothing, so it is never counted either way.
 */
export const qaReleaseTrainLineCounts = (line: string) => line.length >= 4 && /[A-Za-z0-9]/.test(line);

/** The added and removed lines of a unified diff, by the file they belong to (`-U0` is enough). */
export function qaReleaseTrainDiffLines(diff: string): Map<string, { added: string[]; removed: string[] }> {
  const files = new Map<string, { added: string[]; removed: string[] }>();
  let from: string | null = null;
  let current: { added: string[]; removed: string[] } | null = null;
  const entry = (path: string) => {
    if (!files.has(path)) files.set(path, { added: [], removed: [] });
    return files.get(path)!;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      from = null;
      current = null;
    } else if (line.startsWith("--- ")) {
      from = line === "--- /dev/null" ? null : line.slice(6);
    } else if (line.startsWith("+++ ")) {
      const to = line === "+++ /dev/null" ? null : line.slice(6);
      const path = to ?? from;
      current = path === null ? null : entry(path);
    } else if (current && line.startsWith("+")) {
      current.added.push(line.slice(1).trim());
    } else if (current && line.startsWith("-")) {
      current.removed.push(line.slice(1).trim());
    }
  }
  return files;
}

/**
 * One changed file as the git port reads it: the blob the candidate left,
 * and main's and develop's blob and text now. `post` is null for a file the
 * candidate deleted; a side's blob is null where the file does not exist.
 */
export type QaReleaseTrainChangedFile = {
  path: string;
  post: string | null;
  main: string | null;
  develop: string | null;
  binary: boolean;
  mainText?: string | null;
  developText?: string | null;
};

/**
 * The content check of one candidate: its diff and its files as main and
 * develop hold them now. A file main holds exactly as the candidate left it
 * is on main. Otherwise each line the candidate added that main lacks and
 * develop still holds is missing (one develop has since changed again is
 * another pull request's business), and each line it removed that main
 * still holds and develop no longer does is left on main. A binary file that
 * differs from main counts as one missing line unless main already matches
 * develop.
 */
export function qaReleaseTrainContentGap(diff: string, changed: readonly QaReleaseTrainChangedFile[]): { verdict: QaReleaseTrainContentVerdict; gap: QaReleaseTrainGapFile[] } {
  const lines = qaReleaseTrainDiffLines(diff);
  const gap: QaReleaseTrainGapFile[] = [];
  let counted = 0;
  const set = (text: string | null | undefined) => (typeof text === "string" ? new Set(text.split("\n").map((line) => line.trim())) : null);
  for (const file of changed) {
    const own = lines.get(file.path) ?? { added: [], removed: [] };
    const added = own.added.filter(qaReleaseTrainLineCounts);
    const removed = own.removed.filter(qaReleaseTrainLineCounts);
    counted += file.binary ? 1 : added.length + removed.length;
    if (file.main === file.post) continue;
    if (file.binary) {
      if (file.main !== file.develop) gap.push({ path: file.path, missing: [], leftOnMain: [], binary: true });
      continue;
    }
    const main = set(file.mainText);
    const develop = set(file.developText);
    const missing = added.filter((line) => !main?.has(line) && develop?.has(line));
    const leftOnMain = removed.filter((line) => main?.has(line) && !develop?.has(line));
    if (missing.length > 0 || leftOnMain.length > 0) gap.push({ path: file.path, missing, leftOnMain });
  }
  if (gap.length === 0) return { verdict: { state: "on_main", lines: counted }, gap };
  const size = (file: QaReleaseTrainGapFile) => (file.binary ? 1 : file.missing.length + file.leftOnMain.length);
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
  JSON.stringify([...gap].sort((a, b) => a.path.localeCompare(b.path)).map((file) => [file.path, Boolean(file.binary), file.missing, file.leftOnMain]));

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
  "A content check compared its own change with main and develop: you get the lines it added that main lacks (and develop still has), and the lines it removed that main still has.",
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
    `Content check: ${question.verdict.missing} added line(s) main lacks and ${question.verdict.leftOnMain} removed line(s) main still has, in ${question.verdict.fileCount} file(s), out of ${question.verdict.lines} changed line(s).`,
  ];
  const pulls = question.mainPulls.length
    ? ["", "Main pull requests that touched these files after it, or mention it:", ...question.mainPulls.flatMap((pull) => ["", `#${pull.number}: ${pull.title}`, pull.body.slice(0, MAIN_BODY_CHARS)])]
    : ["", "No main pull request touched these files after it or mentions it."];
  let budget = QA_RELEASE_TRAIN_VERDICT_MAX_INPUT_CHARS - head.join("\n").length - pulls.join("\n").length;
  const files: string[] = [""];
  for (const file of question.gap) {
    const part = [
      `File: ${file.path}`,
      ...(file.binary ? ["(binary file: main's copy differs)"] : []),
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
  return [...head, "", "What main lacks (+ added, - removed):", ...files, ...pulls].join("\n");
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

/** The stored verdicts by number, or none when the row does not parse. */
export function qaReleaseTrainVerdictsFrom(value: unknown): QaReleaseTrainVerdicts | null {
  const row = value as Partial<QaReleaseTrainVerdicts> | null;
  if (typeof row !== "object" || row === null || typeof row.mainSha !== "string" || typeof row.at !== "string" || !Array.isArray(row.verdicts)) return null;
  return {
    mainSha: row.mainSha,
    at: row.at,
    verdicts: row.verdicts.filter(
      (verdict): verdict is QaReleaseTrainVerdict =>
        typeof verdict === "object" && verdict !== null && Number.isInteger(verdict.number) && typeof verdict.content?.state === "string",
    ),
  };
}
