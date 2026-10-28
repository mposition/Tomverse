/**
 * The release train's ports (lib/qaReleaseTrainService.ts): GitHub through the
 * merge lane's App installation token, git through a fresh clone of the
 * public repository under the system temp directory, and the app through the
 * lane's secret. No token, key or command output is ever logged or returned:
 * every failure is a fixed error code.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { assertQaReleaseMergeLaneEndpoint, qaReleaseMergeLaneEndpoint } from "./qaReleaseDigestEndpointCore.ts";
import type { QaReleaseHttp } from "./qaReleaseMergeLaneGithub.ts";
import { QA_RELEASE_CONTROL_REVISION_HEADER } from "./qaReleaseRouteAuthCore.ts";
import {
  QA_RELEASE_TRAIN_REPOSITORY,
  qaReleaseTrainIncludedNumbers,
  qaReleaseTrainIsTrainPull,
  qaReleaseTrainMergedPullNumber,
  type QaReleaseTrainCandidate,
  type QaReleaseTrainPick,
} from "./qaReleaseTrainCore.ts";
import {
  QA_RELEASE_TRAIN_MARKER_LINE,
  qaReleaseTrainApplyHunks,
  qaReleaseTrainDiff3Hunks,
  type QaReleaseTrainConflict,
  type QaReleaseTrainResolver,
} from "./qaReleaseTrainResolve.ts";
import type { QaReleaseTrainPorts } from "./qaReleaseTrainService.ts";

const REPOSITORY = QA_RELEASE_TRAIN_REPOSITORY;
const API = `https://api.github.com/repos/${REPOSITORY}`;
const SHA = /^[0-9a-f]{40}$/;
const PULL_READS_AT_ONCE = 8;
/** Open main pull requests are read to this many pages of a hundred. */
const OPEN_PAGE_CAP = 3;
const run = promisify(execFile);

type Json = Record<string, unknown>;
const record = (value: unknown): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("github_shape");
  return value as Json;
};

export function createQaReleaseTrainGithubPorts(input: { http: QaReleaseHttp; token: () => Promise<string> }): QaReleaseTrainPorts["github"] {
  const request = async (method: "GET" | "POST", url: string, body?: Json) => {
    const response = await input.http({
      method,
      url,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${await input.token()}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, json: () => JSON.parse(response.text) as unknown };
  };
  // The pull request itself is the authority on whether it was merged into
  // develop; one that was not is left out.
  const readCargo = async (number: number): Promise<QaReleaseTrainCandidate | null> => {
    const pull = await request("GET", `${API}/pulls/${number}`);
    if (pull.status === 404) return null;
    if (pull.status !== 200) throw new Error(`github_${pull.status}`);
    const data = record(pull.json());
    if (record(data.base).ref !== "develop" || typeof data.merged_at !== "string" || typeof data.merge_commit_sha !== "string") return null;
    return { number, title: String(data.title ?? ""), mergeCommitSha: data.merge_commit_sha, mergedAt: data.merged_at };
  };
  return {
    async branchExists(branch) {
      const answer = await request("GET", `${API}/git/ref/heads/${branch}`);
      if (answer.status === 200) return true;
      if (answer.status === 404) return false;
      throw new Error(`github_${answer.status}`);
    },
    // Every open main pull request, page by page: a train past the first
    // hundred still holds the next one. A list longer than the cap is a
    // failed read, never "no open train". The riders are what each open train
    // names under its Included heading; a fork's pull request is not a train.
    async openTrains() {
      let count = 0;
      const riders = new Set<number>();
      for (let page = 1; page <= OPEN_PAGE_CAP; page += 1) {
        const answer = await request("GET", `${API}/pulls?state=open&base=main&per_page=100&page=${page}`);
        if (answer.status !== 200) throw new Error(`github_${answer.status}`);
        const list = answer.json();
        if (!Array.isArray(list)) throw new Error("github_shape");
        for (const pull of list) {
          if (!qaReleaseTrainIsTrainPull(pull)) continue;
          count += 1;
          const body = record(pull).body;
          for (const number of qaReleaseTrainIncludedNumbers(typeof body === "string" ? body : "")) riders.add(number);
        }
        if (list.length < 100) return { count, riders: [...riders] };
      }
      throw new Error("github_pages");
    },
    async cargo(numbers) {
      const ordered = [...new Set(numbers)];
      const cargo: QaReleaseTrainCandidate[] = [];
      for (let index = 0; index < ordered.length; index += PULL_READS_AT_ONCE) {
        const batch = await Promise.all(ordered.slice(index, index + PULL_READS_AT_ONCE).map((number) => readCargo(number)));
        for (const candidate of batch) if (candidate) cargo.push(candidate);
      }
      return cargo;
    },
    async openPullRequest(pr) {
      const answer = await request("POST", `${API}/pulls`, { head: pr.head, base: "main", title: pr.title, body: pr.body, draft: false });
      if (answer.status !== 201) throw new Error(`github_${answer.status}`);
      const number = record(answer.json()).number;
      if (typeof number !== "number") throw new Error("github_shape");
      return number;
    },
  };
}

/** At most this many conflicting picks go to the model in one train: each call is paid. */
const RESOLVES_PER_TRAIN = 6;
/** The commit trailer naming the files of a conflict the model resolved. */
const RESOLVED_TRAILER = "Release-train-model-resolved";

/**
 * `remote` is for tests only: a local repository path stands in for GitHub,
 * and the push goes to it without a token. `resolve` (owner, 2026-10-28; the
 * service passes one only when switched on): a pick that conflicts has its
 * conflict hunks filled by the model (lib/qaReleaseTrainResolve.ts).
 */
export function createQaReleaseTrainGitPorts(input: {
  token: () => Promise<string>;
  remote?: string;
  resolve?: QaReleaseTrainResolver;
}): QaReleaseTrainPorts["git"] & { cleanup(): Promise<void> } {
  let dir: string | null = null;
  const git = async (args: string[], options: { cwd?: string; allowFail?: boolean; extraEnv?: Record<string, string>; raw?: boolean } = {}) => {
    try {
      const { stdout } = await run("git", args, {
        cwd: options.cwd ?? dir ?? undefined,
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.extraEnv },
      });
      return { ok: true, stdout: options.raw ? stdout : stdout.trim() };
    } catch (error) {
      // No git binary at all is a deployment problem, not a repository one.
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") throw new Error("git_missing");
      if (options.allowFail) return { ok: false, stdout: "" };
      throw new Error(`git_${args[0] === "clone" ? "clone" : args[0] === "push" ? "push" : "failed"}`);
    }
  };
  /** Commits whose conflict the model resolved, with the files and what it said. */
  const resolvedCommits = new Map<string, { files: readonly string[]; why: string }>();
  let resolves = 0;
  // A stopped pick's conflicts handed to the model, which fills every hunk;
  // the files are written and staged. Only regular UTF-8 text files on all
  // three sides with no marker-like line are handed over. `why` is empty
  // when no resolver is set.
  const resolveConflict = async (pull: QaReleaseTrainCandidate, files: readonly string[]): Promise<{ resolved: boolean; why: string }> => {
    if (!input.resolve) return { resolved: false, why: "" };
    // A name the trailer or the body's code span cannot carry as one item is not resolved.
    if (!dir || files.length === 0 || files.some((file) => /[,`\r\n]/.test(file))) return { resolved: false, why: "A conflicted file's name cannot be carried." };
    if (resolves >= RESOLVES_PER_TRAIN) return { resolved: false, why: "This train already handed the model its limit of conflicts." };
    const marked = new Map<string, string[]>();
    const conflict: QaReleaseTrainConflict = { number: pull.number, title: pull.title, diff: "", files: [] };
    for (const file of files) {
      const notText = { resolved: false, why: `\`${file}\` is not a text file changed on both sides.` };
      // Changed on one side and deleted on the other, a symlink or a submodule is not handed over.
      const stages = (await git(["ls-files", "-u", "--", file], { allowFail: true })).stdout.split("\n").filter((row) => row !== "");
      if (stages.length !== 3 || !stages.every((row) => /^100(644|755) [0-9a-f]{40} [123]\t/.test(row))) return notText;
      // Nor a binary one (git leaves it without markers) or one holding marker-like lines.
      for (const stage of [1, 2, 3]) {
        const side = await git(["show", `:${stage}:${file}`], { allowFail: true, raw: true });
        if (!side.ok || side.stdout.includes("\0") || QA_RELEASE_TRAIN_MARKER_LINE.test(side.stdout)) return notText;
      }
      if (!(await git(["checkout", "--conflict=diff3", "--", file], { allowFail: true })).ok) return notText;
      // Written back as UTF-8, so only a file that is strictly UTF-8 (byte order mark kept).
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(join(dir, file)));
      } catch {
        return notText;
      }
      const lines = text.split("\n");
      const hunks = qaReleaseTrainDiff3Hunks(lines);
      // A conflicted file with no hunk to read is one git could not mark.
      if (hunks === null || hunks.length === 0) return notText;
      marked.set(file, lines);
      conflict.files.push({ path: file, hunks });
    }
    conflict.diff = (await git(["diff", "--no-color", "--no-ext-diff", `${pull.mergeCommitSha}^1`, pull.mergeCommitSha, "--", ...files], { allowFail: true })).stdout;
    resolves += 1;
    const answer = await input.resolve(conflict);
    if (!answer.resolved) return answer;
    for (const file of answer.files) {
      await writeFile(join(dir, file.path), qaReleaseTrainApplyHunks(marked.get(file.path) ?? [], file.hunks).join("\n"));
      if (!(await git(["add", "--", file.path], { allowFail: true })).ok) return { resolved: false, why: "A resolved file could not be staged." };
    }
    return answer;
  };
  type Attempt = { result: "applied" } | { result: "empty" } | { result: "workflows" } | { result: "conflict"; why: string };
  // One cherry-pick onto the train branch; whatever it does not keep is undone.
  const pickOnce = async (pull: QaReleaseTrainCandidate): Promise<Attempt> => {
    const before = (await git(["rev-parse", "HEAD"])).stdout;
    let picked = (await git(["cherry-pick", "-m", "1", pull.mergeCommitSha], { allowFail: true })).ok;
    if (!picked) {
      // A pick that stopped with nothing to apply and no conflict is already on main.
      const unmerged = (await git(["diff", "--name-only", "--diff-filter=U"])).stdout;
      const staged = await git(["diff", "--cached", "--quiet"], { allowFail: true });
      if (unmerged === "" && staged.ok) {
        await git(["cherry-pick", "--skip"], { allowFail: true });
        return { result: "empty" };
      }
      const files = unmerged.split("\n").filter((file) => file !== "");
      const answer = await resolveConflict(pull, files);
      picked = answer.resolved;
      // Resolved to nothing new: main already had what it adds. A skip that fails is aborted like a conflict.
      if (picked && (await git(["diff", "--cached", "--quiet"], { allowFail: true })).ok) {
        if ((await git(["cherry-pick", "--skip"], { allowFail: true })).ok) return { result: "empty" };
        picked = false;
      }
      // Resolved, it commits with the original message and a trailer naming the files.
      picked = picked && (await git(["commit", "--quiet", "--no-edit", "--trailer", `${RESOLVED_TRAILER}: ${files.join(", ")}`], { allowFail: true })).ok;
      if (!picked) {
        await git(["cherry-pick", "--abort"]);
        return { result: "conflict", why: answer.why };
      }
      // Kept here, not read back from messages: a develop merge commit's own message could carry the trailer's words.
      resolvedCommits.set((await git(["rev-parse", "HEAD"])).stdout, { files, why: answer.why });
    }
    if ((await git(["rev-parse", "HEAD"])).stdout === before) return { result: "empty" };
    // The App has no workflows permission, and GitHub refuses a push that
    // adds or changes a workflow file without it: the whole train would
    // fail. Such a pull request comes back off and is released alone.
    const touched = (await git(["diff", "--name-only", before, "HEAD"])).stdout.split("\n");
    if (touched.some((file) => file.startsWith(".github/workflows/"))) {
      await git(["reset", "--quiet", "--hard", before]);
      return { result: "workflows" };
    }
    return { result: "applied" };
  };
  return {
    async assemble(branch, cargo, capacity) {
      // A round that assembles twice (an empty emergency, then the scheduled
      // train) keeps one clone: the first is removed before the second.
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "qa-release-train-"));
      await git(["clone", "--quiet", "--config", "core.autocrlf=false", "--filter=blob:none", "--no-tags", "--single-branch", "--branch", "main", input.remote ?? `https://github.com/${REPOSITORY}.git`, dir], { cwd: tmpdir() });
      await git(["config", "user.name", "tomverse-qa-release-train"]);
      await git(["config", "user.email", "qa-release-train@users.noreply.github.com"]);
      const mainSha = (await git(["rev-parse", "HEAD"])).stdout;
      if (!SHA.test(mainSha)) throw new Error("git_shape");
      if (cargo.length > 0) await git(["fetch", "--quiet", "--filter=blob:none", "origin", ...cargo.map((c) => c.mergeCommitSha)]);
      await git(["switch", "--quiet", "-c", branch]);
      const picks: QaReleaseTrainPick[] = [];
      const riding = () => picks.filter((p) => p.outcome === "included").length;
      for (const pull of cargo) {
        if (riding() >= capacity) {
          picks.push({ number: pull.number, outcome: "over_capacity" });
          continue;
        }
        // Already reachable from main (a full release carried it).
        if ((await git(["merge-base", "--is-ancestor", pull.mergeCommitSha, "HEAD"], { allowFail: true })).ok) {
          picks.push({ number: pull.number, outcome: "already_in_main" });
          continue;
        }
        const ride = await pickOnce(pull);
        if (ride.result === "applied") picks.push({ number: pull.number, outcome: "included" });
        else if (ride.result === "workflows") picks.push({ number: pull.number, outcome: "changes_workflows" });
        else if (ride.result === "empty") picks.push({ number: pull.number, outcome: "already_in_main" });
        else picks.push({ number: pull.number, outcome: "conflict", ...(ride.why ? { why: ride.why } : {}) });
      }
      const headSha = (await git(["rev-parse", "HEAD"])).stdout;
      // What rides resolved: the commits the model resolved that are still on the branch (an attempt undone took its commit with it).
      const resolved: { number: number; files: string[]; why: string }[] = [];
      for (const entry of (await git(["log", "--format=%H%x1f%s", `${mainSha}..HEAD`])).stdout.split("\n")) {
        const [sha = "", subject = ""] = entry.split("\x1f");
        const number = qaReleaseTrainMergedPullNumber(subject);
        const kept = resolvedCommits.get(sha);
        if (number !== null && kept) resolved.push({ number, files: [...kept.files], why: kept.why });
      }
      return { mainSha, headSha, picks, resolved };
    },
    async push(branch) {
      if (!dir) throw new Error("git_not_assembled");
      if (input.remote) {
        await git(["push", "--quiet", input.remote, `HEAD:refs/heads/${branch}`]);
        return;
      }
      // The token travels as an environment-supplied config value for this one
      // command: never in argv, a remote, the repository config or a log.
      const basic = Buffer.from(`x-access-token:${await input.token()}`).toString("base64");
      await git(["push", "--quiet", `https://github.com/${REPOSITORY}.git`, `HEAD:refs/heads/${branch}`], {
        extraEnv: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
        },
      });
    },
    async cleanup() {
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
}

export function createQaReleaseTrainAppPorts(input: { http: QaReleaseHttp; env: Readonly<Record<string, string | undefined>> }): QaReleaseTrainPorts["app"] {
  const call = async (body: Json) => {
    const url = qaReleaseMergeLaneEndpoint({ ...input.env }, "train");
    assertQaReleaseMergeLaneEndpoint(url, "train");
    const response = await input.http({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.env.QA_RELEASE_MERGE_LANE_SECRET ?? ""}`,
        [QA_RELEASE_CONTROL_REVISION_HEADER]: (input.env.QA_RELEASE_CONTROL_REVISION ?? "").trim(),
      },
      body: JSON.stringify(body),
    });
    if (response.status !== 200 && response.status !== 409) throw new Error(`app_${response.status}`);
    return { status: response.status, body: record(JSON.parse(response.text)) };
  };
  return {
    async schedule(hours) {
      await call({ phase: "schedule", hours });
    },
    async selection() {
      const answer = await call({ phase: "selection" });
      const isNumbers = (value: unknown): value is number[] => Array.isArray(value) && value.every((n) => Number.isInteger(n) && n > 0);
      const numbers = answer.status === 200 ? answer.body.numbers : null;
      if (!isNumbers(numbers)) throw new Error("app_selection_shape");
      // An app older than emergency trains sends no `emergency`: none is waiting.
      const emergency = (answer.body.emergency ?? null) as { id?: unknown; numbers?: unknown } | null;
      if (emergency === null) return { numbers, emergency: null };
      if (typeof emergency !== "object" || typeof emergency.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(emergency.id) || !isNumbers(emergency.numbers)) {
        throw new Error("app_selection_shape");
      }
      return { numbers, emergency: { id: emergency.id, numbers: emergency.numbers } };
    },
    async admit(slot, emergencyRequestId) {
      const answer = await call({ phase: "admit", slot, ...(emergencyRequestId ? { emergencyRequestId } : {}) });
      return answer.status === 200 && answer.body.admitted === true
        ? { admitted: true }
        : { admitted: false, reason: typeof answer.body.reason === "string" ? answer.body.reason : "unknown" };
    },
    async report(report) {
      const send = (picks: QaReleaseTrainPick[]) => call({ phase: "report", ...report, picks });
      let answer;
      try {
        answer = await send(report.picks);
      } catch (error) {
        // An app older than model resolution refuses `why` (400: nothing was
        // written). Sent again without it, the report still lands.
        if (!(error instanceof Error && error.message === "app_400") || !report.picks.some((p) => p.why !== undefined)) throw error;
        answer = await send(
          report.picks.map((pick) => {
            const plain = { ...pick };
            delete plain.why;
            return plain;
          }),
        );
      }
      if (answer.status !== 200) throw new Error("app_report_refused");
    },
  };
}
