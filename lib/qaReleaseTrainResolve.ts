/**
 * The release train's conflict resolver (owner, 2026-10-28): a pick that
 * conflicts on main is handed to a model, which writes what each conflict
 * hunk becomes. It replaced the hand-written predecessor boarding and
 * adjacent-line settlement, which could not tell a paragraph since moved
 * (#2702: AGENTS.md was rewritten), a pull request main already carries under
 * another commit (#2583, ported by a hand-made release), or a neighbour main
 * never had (#2726 beside #2212's services).
 *
 * Off unless `QA_RELEASE_TRAIN_MODEL_RESOLVE` is exactly "true" and the
 * train's own Anthropic key is set: every call is paid. The model only fills
 * conflict hunks; the caller writes nothing else, refuses an answer that does
 * not cover every hunk or still holds a conflict marker, and the train's pull
 * request names every file resolved this way for the operator, before CI and
 * the operator's merge.
 */
import type { QaReleaseHttp } from "./qaReleaseMergeLaneGithub.ts";

export const QA_RELEASE_TRAIN_RESOLVE_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const QA_RELEASE_TRAIN_RESOLVE_MODEL = "claude-opus-5-5";
/** What one request may carry; a larger conflict is left out unasked. */
export const QA_RELEASE_TRAIN_RESOLVE_MAX_INPUT_CHARS = 300_000;
/** What the answer's `why` keeps: it is shown in Admin and the public pull request. */
export const QA_RELEASE_TRAIN_RESOLVE_WHY_CHARS = 300;
/** A line git would read as a conflict marker. */
export const QA_RELEASE_TRAIN_MARKER_LINE = /^(<{7}|\|{7}|>{7})( |$)|^={7}$/m;

/** One conflict hunk in diff3 form, with the file's lines around it. */
export type QaReleaseTrainHunk = { before: string[]; main: string[]; base: string[]; pick: string[]; after: string[] };
export type QaReleaseTrainConflict = {
  number: number;
  title: string;
  /** The pull request's own change to the conflicted files. */
  diff: string;
  files: { path: string; hunks: QaReleaseTrainHunk[] }[];
};
export type QaReleaseTrainResolution =
  | { resolved: true; why: string; files: { path: string; hunks: string[][] }[] }
  | { resolved: false; why: string };
export type QaReleaseTrainResolver = (conflict: QaReleaseTrainConflict) => Promise<QaReleaseTrainResolution>;

const SYSTEM = [
  "You resolve cherry-pick conflicts for a release branch.",
  "`main` is the release branch. The pull request was merged into develop and is being cherry-picked onto main; develop holds other pull requests that are not on main yet.",
  "Each conflict hunk gives main's lines, `base` (the develop lines the pull request was written against) and `pick` (those lines after the pull request), with the file's lines around it.",
  "Write what each hunk becomes on main: main's lines with only this pull request's own change applied.",
  "Never bring in lines that only base or develop has and this pull request did not add: they belong to pull requests main does not have.",
  "When the pull request edits text main no longer has (moved or rewritten since), keep main's lines.",
  "If the change cannot be applied correctly without code main lacks, answer resolved false and say in `why` what is missing.",
  "`why`: one or two plain sentences on what you did or what is missing. Give `files` in the order received and every hunk of each, in order; `lines` is the hunk's whole new text, one string per line.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    resolved: { type: "boolean" },
    why: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          hunks: {
            type: "array",
            items: { type: "object", properties: { lines: { type: "array", items: { type: "string" } } }, required: ["lines"], additionalProperties: false },
          },
        },
        required: ["path", "hunks"],
        additionalProperties: false,
      },
    },
  },
  required: ["resolved", "why", "files"],
  additionalProperties: false,
};

const fail = (why: string): QaReleaseTrainResolution => ({ resolved: false, why });

/**
 * The hunks of a file git wrote in diff3 form, each with up to `context`
 * lines of the file around it; null when one is unclosed or lacks a side.
 */
export function qaReleaseTrainDiff3Hunks(lines: readonly string[], context = 20): QaReleaseTrainHunk[] | null {
  const hunks: QaReleaseTrainHunk[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].startsWith("<<<<<<< ")) {
      i++;
      continue;
    }
    const hunk: QaReleaseTrainHunk = { before: lines.slice(Math.max(0, i - context), i), main: [], base: [], pick: [], after: [] };
    let side = hunk.main;
    for (i++; i < lines.length && !lines[i].startsWith(">>>>>>> "); i++) {
      if (lines[i].startsWith("||||||| ") && side === hunk.main) side = hunk.base;
      else if (lines[i] === "=======" && side === hunk.base) side = hunk.pick;
      else side.push(lines[i]);
    }
    if (i++ >= lines.length || side !== hunk.pick) return null;
    hunk.after = lines.slice(i, i + context);
    hunks.push(hunk);
  }
  return hunks;
}

/** The file with each diff3 hunk replaced by its resolved lines, in order. */
export function qaReleaseTrainApplyHunks(lines: readonly string[], resolved: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  let next = 0;
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].startsWith("<<<<<<< ")) {
      out.push(lines[i++]);
      continue;
    }
    while (i < lines.length && !lines[i].startsWith(">>>>>>> ")) i++;
    i++;
    out.push(...resolved[next++]);
  }
  return out;
}

/** The model's answer checked against the conflict it was given: every hunk answered, in order, and no marker left. */
export function qaReleaseTrainResolutionFrom(conflict: QaReleaseTrainConflict, answer: unknown): QaReleaseTrainResolution {
  const value = answer as { resolved?: unknown; why?: unknown; files?: unknown } | null;
  if (typeof value !== "object" || value === null || typeof value.resolved !== "boolean" || typeof value.why !== "string" || !Array.isArray(value.files)) {
    return fail("The model's answer did not have the expected shape.");
  }
  const why = value.why.replace(/\s+/g, " ").trim().slice(0, QA_RELEASE_TRAIN_RESOLVE_WHY_CHARS) || "The model gave no reason.";
  if (!value.resolved) return fail(why);
  const answered = value.files as { path?: unknown; hunks?: { lines?: unknown }[] }[];
  if (answered.length !== conflict.files.length) return fail("The model's answer did not cover every conflicted file.");
  const files: { path: string; hunks: string[][] }[] = [];
  for (const [index, file] of conflict.files.entries()) {
    const got = answered[index];
    if (got?.path !== file.path || !Array.isArray(got.hunks) || got.hunks.length !== file.hunks.length) {
      return fail("The model's answer did not cover every conflict hunk.");
    }
    const hunks = got.hunks.map((hunk) => (Array.isArray(hunk?.lines) && hunk.lines.every((line) => typeof line === "string") ? (hunk.lines as string[]) : null));
    if (hunks.some((lines) => lines === null)) return fail("The model's answer did not cover every conflict hunk.");
    if (hunks.some((lines) => QA_RELEASE_TRAIN_MARKER_LINE.test((lines as string[]).join("\n")))) return fail("The model's answer still held a conflict marker.");
    files.push({ path: file.path, hunks: hunks as string[][] });
  }
  return { resolved: true, why, files };
}

/** The request the model sees: the pull request, its diff and each hunk with its surroundings. */
export function qaReleaseTrainResolvePrompt(conflict: QaReleaseTrainConflict): string {
  const lines = [`Pull request #${conflict.number}: ${conflict.title}`, "", "Its change to the conflicted files:", "```diff", conflict.diff, "```"];
  for (const file of conflict.files) {
    lines.push("", `File: ${file.path}`);
    file.hunks.forEach((hunk, index) => {
      lines.push(
        `Hunk ${index + 1}:`,
        "lines before:",
        ...hunk.before,
        "<<<<<<< main",
        ...hunk.main,
        "||||||| base",
        ...hunk.base,
        "=======",
        ...hunk.pick,
        ">>>>>>> pick",
        "lines after:",
        ...hunk.after,
      );
    });
  }
  return lines.join("\n");
}

/** A resolver that asks the model once per conflicting pick; any failure is "not resolved", never a guess. */
export function createQaReleaseTrainResolver(input: { http: QaReleaseHttp; apiKey: string }): QaReleaseTrainResolver {
  return async (conflict) => {
    const prompt = qaReleaseTrainResolvePrompt(conflict);
    if (prompt.length > QA_RELEASE_TRAIN_RESOLVE_MAX_INPUT_CHARS) return fail("The conflict is too large to hand to the model.");
    let response;
    try {
      response = await input.http({
        method: "POST",
        url: QA_RELEASE_TRAIN_RESOLVE_ENDPOINT,
        headers: { "content-type": "application/json", "x-api-key": input.apiKey, "anthropic-version": "2026-10-21" },
        body: JSON.stringify({
          model: QA_RELEASE_TRAIN_RESOLVE_MODEL,
          max_tokens: 32_000,
          output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
          system: SYSTEM,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch {
      return fail("The model could not be reached.");
    }
    if (response.status !== 200) return fail(`The model call failed (HTTP ${response.status}).`);
    try {
      const message = JSON.parse(response.text) as { stop_reason?: unknown; content?: { type?: unknown; text?: unknown }[] };
      if (message.stop_reason !== "end_turn") return fail(`The model stopped early (${String(message.stop_reason).slice(0, 20)}).`);
      const text = (message.content ?? []).find((block) => block.type === "text")?.text;
      return qaReleaseTrainResolutionFrom(conflict, typeof text === "string" ? JSON.parse(text) : null);
    } catch {
      return fail("The model's answer could not be read.");
    }
  };
}
