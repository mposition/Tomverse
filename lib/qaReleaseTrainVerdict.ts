/**
 * The train service's verdict round (owner, 2026-10-29;
 * lib/qaReleaseTrainVerdictCore.ts): after its train round, the service
 * checks the content of every next-train candidate Admin lists as able to
 * ride, and asks the model about each one whose difference from main is left.
 * The results go to the app as one display-only record that Admin reads.
 *
 * It clones only when main moved, a candidate has no verdict yet, or a
 * difference still waits for the model. The model is asked at most
 * QA_RELEASE_TRAIN_VERDICT_ASKS_PER_ROUND times a round, each difference once
 * (a failed ask is not repeated for VERDICT_RETRY_MS), on the train's own
 * key; it is off when the service has no key or
 * QA_RELEASE_TRAIN_MODEL_VERDICT is "false".
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { QaReleaseHttp } from "./qaReleaseMergeLaneGithub.ts";
import { QA_RELEASE_TRAIN_REPOSITORY, qaReleaseTrainMergedPullNumber } from "./qaReleaseTrainCore.ts";
import { QA_RELEASE_TRAIN_RESOLVE_ENDPOINT, QA_RELEASE_TRAIN_RESOLVE_MODEL } from "./qaReleaseTrainResolve.ts";
import {
  QA_RELEASE_TRAIN_VERDICT_MAX_INPUT_CHARS,
  QA_RELEASE_TRAIN_VERDICT_SCHEMA,
  QA_RELEASE_TRAIN_VERDICT_SYSTEM,
  qaReleaseTrainContentGap,
  qaReleaseTrainGapText,
  qaReleaseTrainModelVerdictFrom,
  qaReleaseTrainVerdictPrompt,
  type QaReleaseTrainChangedFile,
  type QaReleaseTrainModelVerdict,
  type QaReleaseTrainVerdict,
  type QaReleaseTrainVerdictQuestion,
  type QaReleaseTrainVerdicts,
} from "./qaReleaseTrainVerdictCore.ts";

/** Each call is paid: at most this many a round. */
export const QA_RELEASE_TRAIN_VERDICT_ASKS_PER_ROUND = 10;
/** A failed ask about the same difference waits this long before the next. */
const VERDICT_RETRY_MS = 6 * 60 * 60 * 1000;
/** A candidate whose content could not be read is checked again after this. */
const UNREAD_RETRY_MS = 60 * 60 * 1000;
/** No model call starts with less than this left before the round's deadline. */
const ASK_MARGIN_MS = 5 * 60 * 1000;
/** Main pull requests shown to the model for one candidate. */
const MAIN_PULLS_SHOWN = 6;
/** Differing files whose main history is searched for the pull requests that touched them. */
const PATHS_SEARCHED = 40;

export type QaReleaseTrainVerdictCandidate = {
  number: number;
  title: string;
  mergeCommitSha: string;
  mergedAt: string;
  /** The main pull request that mentions it, when Admin knows one. */
  mainPullRequest: number | null;
};

export type QaReleaseTrainVerdictPorts = {
  app: {
    /** The candidates Admin lists as able to ride, and the verdicts it holds. */
    queue(): Promise<{ candidates: QaReleaseTrainVerdictCandidate[]; stored: QaReleaseTrainVerdicts | null }>;
    save(verdicts: QaReleaseTrainVerdicts): Promise<void>;
  };
  git: {
    /** Main's head on GitHub, without cloning. */
    mainHead(): Promise<string>;
    /** A fresh clone holding main and develop; returns main's head. */
    prepare(): Promise<string>;
    /** One candidate's own change and its files as main and develop hold them. */
    analyse(candidate: QaReleaseTrainVerdictCandidate): Promise<{ changed: QaReleaseTrainChangedFile[] }>;
    /** Main pull requests merged since a moment that touched these files, newest first. */
    mainPullsTouching(paths: readonly string[], since: string): Promise<number[]>;
  };
  github: { pull(number: number): Promise<{ title: string; body: string } | null> };
  /** Absent: the model is off. */
  ask?: (question: QaReleaseTrainVerdictQuestion) => Promise<QaReleaseTrainModelVerdict | null>;
};

export type QaReleaseTrainVerdictOutcome =
  | { verdict: "none" | "unchanged" }
  | { verdict: "saved"; checked: number; onMain: number; differs: number; asked: number }
  | { verdict: "failed"; failure: string };

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);

const failure = (step: string, error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  return `${step}:${/^[a-z0-9_]{1,40}$/.test(message) ? message : "unknown"}`;
};

/** A verdict that still waits for the model: a difference never asked about, or asked about long enough ago. */
const awaitsModel = (verdict: QaReleaseTrainVerdict | undefined, nowMs: number) =>
  verdict?.content.state === "differs" && !verdict.model && (!verdict.askedAt || nowMs - Date.parse(verdict.askedAt) > VERDICT_RETRY_MS);

/**
 * A candidate to check again: none yet, checked against another main (one a
 * round's deadline skipped keeps its older one), or unread long enough ago.
 */
const awaitsCheck = (verdict: QaReleaseTrainVerdict | undefined, head: string, nowMs: number) =>
  !verdict ||
  verdict.mainSha !== head ||
  (verdict.content.state === "unread" && (!verdict.checkedAt || nowMs - Date.parse(verdict.checkedAt) > UNREAD_RETRY_MS));

export async function runQaReleaseTrainVerdictRound(
  ports: QaReleaseTrainVerdictPorts,
  options: { deadlineMs: number; now?: () => number },
): Promise<QaReleaseTrainVerdictOutcome> {
  const now = options.now ?? Date.now;
  let step = "queue";
  try {
    const { candidates, stored } = await ports.app.queue();
    if (candidates.length === 0) return { verdict: "none" };
    const before = new Map((stored?.verdicts ?? []).map((verdict) => [verdict.number, verdict]));
    step = "main_head";
    const head = await ports.git.mainHead();
    const due = candidates.some(
      (candidate) =>
        awaitsCheck(before.get(candidate.number), head, now()) || (ports.ask !== undefined && awaitsModel(before.get(candidate.number), now())),
    );
    if (!due) return { verdict: "unchanged" };

    step = "prepare";
    const mainSha = await ports.git.prepare();
    const verdicts: QaReleaseTrainVerdict[] = [];
    let asked = 0;
    // Newest first: what was merged last is the likeliest to ride next.
    for (const candidate of [...candidates].sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))) {
      // Past the deadline the rest keep what they had; the next round checks them.
      if (now() > options.deadlineMs) {
        const earlier = before.get(candidate.number);
        if (earlier) verdicts.push(earlier);
        continue;
      }
      // Checked against this main already, and not waiting for the model: kept as it is.
      const stale = before.get(candidate.number);
      if (stale && !awaitsCheck(stale, mainSha, now()) && !(ports.ask && awaitsModel(stale, now()))) {
        verdicts.push(stale);
        continue;
      }
      const checkedOn = { mainSha, checkedAt: new Date(now()).toISOString() };
      let checked;
      try {
        const read = await ports.git.analyse(candidate);
        checked = qaReleaseTrainContentGap(read.changed);
      } catch {
        verdicts.push({ number: candidate.number, content: { state: "unread" }, ...checkedOn });
        continue;
      }
      const { verdict: content, gap } = checked;
      if (content.state !== "differs") {
        verdicts.push({ number: candidate.number, content, ...checkedOn });
        continue;
      }
      const gapDigest = digest(qaReleaseTrainGapText(gap));
      const earlier = before.get(candidate.number);
      const kept: QaReleaseTrainVerdict = { number: candidate.number, content, ...checkedOn, gapDigest };
      if (earlier?.gapDigest === gapDigest) {
        // The same difference: what the model said, or when it was last asked, still holds.
        if (earlier.model) kept.model = earlier.model;
        else if (earlier.askedAt) kept.askedAt = earlier.askedAt;
      }
      if (ports.ask && awaitsModel(kept, now()) && asked < QA_RELEASE_TRAIN_VERDICT_ASKS_PER_ROUND && options.deadlineMs - now() > ASK_MARGIN_MS) {
        asked += 1;
        kept.askedAt = new Date(now()).toISOString();
        const question = await verdictQuestion(ports, candidate, content, gap).catch(() => null);
        const answer = question ? await ports.ask(question).catch(() => null) : null;
        if (answer) kept.model = answer;
      }
      verdicts.push(kept);
    }
    step = "save";
    await ports.app.save({ mainSha, at: new Date(now()).toISOString(), verdicts });
    return {
      verdict: "saved",
      checked: verdicts.length,
      onMain: verdicts.filter((verdict) => verdict.content.state === "on_main").length,
      differs: verdicts.filter((verdict) => verdict.content.state === "differs").length,
      asked,
    };
  } catch (error) {
    return { verdict: "failed", failure: failure(step, error) };
  }
}

/** What the model is shown about one candidate: its description and the main pull requests near its difference. */
async function verdictQuestion(
  ports: QaReleaseTrainVerdictPorts,
  candidate: QaReleaseTrainVerdictCandidate,
  verdict: QaReleaseTrainVerdictQuestion["verdict"],
  gap: QaReleaseTrainVerdictQuestion["gap"],
): Promise<QaReleaseTrainVerdictQuestion> {
  const own = await ports.github.pull(candidate.number);
  const touching = await ports.git.mainPullsTouching(
    gap.slice(0, PATHS_SEARCHED).map((file) => file.path),
    candidate.mergedAt,
  );
  const numbers = [...new Set([...(candidate.mainPullRequest ? [candidate.mainPullRequest] : []), ...touching])].slice(0, MAIN_PULLS_SHOWN);
  const mainPulls = [];
  for (const number of numbers) {
    const pull = await ports.github.pull(number);
    if (pull) mainPulls.push({ number, ...pull });
  }
  return {
    number: candidate.number,
    title: own?.title ?? candidate.title,
    body: own?.body ?? "",
    mergedAt: candidate.mergedAt,
    verdict,
    gap,
    mainPulls,
  };
}

/** One model call per question; any failure is no answer, never a guess. */
export function createQaReleaseTrainVerdictModel(input: { http: QaReleaseHttp; apiKey: string }): NonNullable<QaReleaseTrainVerdictPorts["ask"]> {
  return async (question) => {
    const prompt = qaReleaseTrainVerdictPrompt(question);
    if (prompt.length > QA_RELEASE_TRAIN_VERDICT_MAX_INPUT_CHARS + 1_000) return null;
    const response = await input.http({
      method: "POST",
      url: QA_RELEASE_TRAIN_RESOLVE_ENDPOINT,
      headers: { "content-type": "application/json", "x-api-key": input.apiKey, "anthropic-version": "2026-10-21" },
      body: JSON.stringify({
        model: QA_RELEASE_TRAIN_RESOLVE_MODEL,
        max_tokens: 4_000,
        output_config: { effort: "medium", format: { type: "json_schema", schema: QA_RELEASE_TRAIN_VERDICT_SCHEMA } },
        system: QA_RELEASE_TRAIN_VERDICT_SYSTEM,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (response.status !== 200) return null;
    const message = JSON.parse(response.text) as { stop_reason?: unknown; content?: { type?: unknown; text?: unknown }[] };
    if (message.stop_reason !== "end_turn") return null;
    const text = (message.content ?? []).find((block) => block.type === "text")?.text;
    return qaReleaseTrainModelVerdictFrom(typeof text === "string" ? JSON.parse(text) : null, [
      question.number,
      ...question.mainPulls.map((pull) => pull.number),
    ]);
  };
}

/* ------------------------------------------------------------------------- */
/* Ports                                                                     */
/* ------------------------------------------------------------------------- */

const run = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const ZERO = /^0{40}$/;
const PATHS_PER_CALL = 200;

/**
 * Git through a fresh partial clone of the public repository: main checked
 * out, develop checked out beside it. `remote` is for tests only (a local
 * repository stands in for GitHub). Every failure is a fixed code.
 */
export function createQaReleaseTrainVerdictGit(input: { remote?: string } = {}): QaReleaseTrainVerdictPorts["git"] & { cleanup(): Promise<void> } {
  const remote = input.remote ?? `https://github.com/${QA_RELEASE_TRAIN_REPOSITORY}.git`;
  /** The temporary directory this port made, and the only one it removes. */
  let root: string | null = null;
  /** Main's checkout inside it, once cloned. */
  let dir: string | null = null;
  let mainSha = "";
  let developSha = "";
  const git = async (args: string[], cwd?: string) => {
    try {
      const { stdout } = await run("git", args, {
        cwd: cwd ?? dir ?? undefined,
        timeout: 180_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") throw new Error("git_missing");
      throw new Error(args[0] === "clone" ? "git_clone" : "git_failed");
    }
  };
  /** Path -> `<mode> <blob>` at a commit, for these paths only. */
  const blobs = async (commit: string, paths: readonly string[]) => {
    const found = new Map<string, string>();
    for (let index = 0; index < paths.length; index += PATHS_PER_CALL) {
      const out = await git(["--literal-pathspecs", "ls-tree", "-r", "-z", commit, "--", ...paths.slice(index, index + PATHS_PER_CALL)]);
      for (const entry of out.split("\0")) {
        const match = /^(\d{6}) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry);
        if (match) found.set(match[3], `${match[1]} ${match[2]}`);
      }
    }
    return found;
  };
  const text = async (root: string, path: string) => {
    try {
      return await readFile(join(root, path), "utf8");
    } catch {
      return null;
    }
  };
  return {
    async mainHead() {
      const out = await git(["ls-remote", remote, "refs/heads/main"], tmpdir());
      const sha = out.split(/\s/)[0] ?? "";
      if (!SHA.test(sha)) throw new Error("git_shape");
      return sha;
    },
    async prepare() {
      root = await mkdtemp(join(tmpdir(), "qa-release-verdict-"));
      const main = join(root, "main");
      await git(["clone", "--quiet", "--config", "core.autocrlf=false", "--filter=blob:none", "--no-tags", "--single-branch", "--branch", "main", remote, main], root);
      dir = main;
      await git(["fetch", "--quiet", "--filter=blob:none", "origin", "+refs/heads/develop:refs/remotes/origin/develop"]);
      await git(["worktree", "add", "--quiet", "--detach", join(root, "develop"), "origin/develop"]);
      mainSha = (await git(["rev-parse", "HEAD"])).trim();
      developSha = (await git(["rev-parse", "origin/develop"])).trim();
      if (!SHA.test(mainSha) || !SHA.test(developSha)) throw new Error("git_shape");
      return mainSha;
    },
    async analyse(candidate) {
      if (!dir || !SHA.test(candidate.mergeCommitSha)) throw new Error("git_not_prepared");
      const range = [`${candidate.mergeCommitSha}^1`, candidate.mergeCommitSha];
      const post = new Map<string, string | null>();
      // `-z` raw output: ":<modes> <old> <new> <status>" then the path, each NUL-terminated.
      const raw = (await git(["diff", "--raw", "-z", "--no-renames", "--no-abbrev", ...range])).split("\0");
      for (let index = 0; index + 1 < raw.length && raw[index].startsWith(":"); index += 2) {
        const [, mode = "", , after = ""] = raw[index].slice(1).split(" ");
        // Mode and blob together: a change of mode alone is a change.
        post.set(raw[index + 1], ZERO.test(after) ? null : `${mode} ${after}`);
      }
      const binary = new Set<string>();
      for (const line of (await git(["diff", "--numstat", "-z", "--no-renames", ...range])).split("\0")) {
        const match = /^-\t-\t([\s\S]+)$/.exec(line);
        if (match) binary.add(match[1]);
      }
      const paths = [...post.keys()];
      const [onMain, onDevelop] = await Promise.all([blobs(mainSha, paths), blobs(developSha, paths)]);
      const developRoot = join(root ?? dir, "develop");
      const changed: QaReleaseTrainChangedFile[] = [];
      for (const path of paths) {
        const file: QaReleaseTrainChangedFile = {
          path,
          post: post.get(path) ?? null,
          main: onMain.get(path) ?? null,
          develop: onDevelop.get(path) ?? null,
          binary: binary.has(path),
        };
        // Text is read only where the check compares it: not where main already matches the change or develop.
        if (!file.binary && file.main !== file.post && file.main !== file.develop) {
          // This path's diff alone, the path given literally: nothing is parsed out of a header.
          file.diff = await git(["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3", ...range, "--", path]);
          file.mainText = file.main ? await text(dir, path) : null;
          file.developText = file.develop ? await text(developRoot, path) : null;
        }
        changed.push(file);
      }
      return { changed };
    },
    async mainPullsTouching(paths, since) {
      if (!dir || paths.length === 0) return [];
      const out = await git(["--literal-pathspecs", "log", "--first-parent", `--since=${since}`, "--format=%s", mainSha, "--", ...paths]);
      return [...new Set(out.split("\n").map(qaReleaseTrainMergedPullNumber).filter((n): n is number => n !== null))];
    },
    async cleanup() {
      if (root) await rm(root, { recursive: true, force: true });
      root = null;
      dir = null;
    },
  };
}

/** A pull request's title and description through the train's App token; null when it does not exist. */
export function createQaReleaseTrainVerdictGithub(input: { http: QaReleaseHttp; token: () => Promise<string> }): QaReleaseTrainVerdictPorts["github"] {
  return {
    async pull(number) {
      const response = await input.http({
        method: "GET",
        url: `https://api.github.com/repos/${QA_RELEASE_TRAIN_REPOSITORY}/pulls/${number}`,
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${await input.token()}`, "x-github-api-version": "2022-11-28" },
      });
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error(`github_${response.status}`);
      const data = JSON.parse(response.text) as { title?: unknown; body?: unknown };
      return { title: String(data.title ?? ""), body: typeof data.body === "string" ? data.body : "" };
    },
  };
}
