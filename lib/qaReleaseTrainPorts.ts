/**
 * The release train's ports (lib/qaReleaseTrainService.ts): GitHub through the
 * merge lane's App installation token, git through a fresh clone of the
 * public repository under the system temp directory, and the app through the
 * lane's secret. No token, key or command output is ever logged or returned:
 * every failure is a fixed error code.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { assertQaReleaseMergeLaneEndpoint, qaReleaseMergeLaneEndpoint } from "./qaReleaseDigestEndpointCore.ts";
import type { QaReleaseHttp } from "./qaReleaseMergeLaneGithub.ts";
import { QA_RELEASE_CONTROL_REVISION_HEADER } from "./qaReleaseRouteAuthCore.ts";
import { QA_RELEASE_TRAIN_CANDIDATE_DAYS } from "./qaReleaseTrainCargoCore.ts";
import {
  QA_RELEASE_TRAIN_BRANCH_PREFIX,
  QA_RELEASE_TRAIN_MAX_PREDECESSORS,
  qaReleaseTrainIncludedNumbers,
  qaReleaseTrainMergedPullNumber,
  type QaReleaseTrainCandidate,
  type QaReleaseTrainPick,
} from "./qaReleaseTrainCore.ts";
import type { QaReleaseTrainPorts } from "./qaReleaseTrainService.ts";

const REPOSITORY = "mposition/Tomverse";
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
    // names under its Included heading.
    async openTrains() {
      let count = 0;
      const riders = new Set<number>();
      for (let page = 1; page <= OPEN_PAGE_CAP; page += 1) {
        const answer = await request("GET", `${API}/pulls?state=open&base=main&per_page=100&page=${page}`);
        if (answer.status !== 200) throw new Error(`github_${answer.status}`);
        const list = answer.json();
        if (!Array.isArray(list)) throw new Error("github_shape");
        for (const pull of list) {
          if (!String(record(record(pull).head).ref ?? "").startsWith(QA_RELEASE_TRAIN_BRANCH_PREFIX)) continue;
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

/**
 * `remote` is for tests only: a local repository path stands in for GitHub,
 * and the push goes to it without a token.
 */
export function createQaReleaseTrainGitPorts(input: { token: () => Promise<string>; remote?: string }): QaReleaseTrainPorts["git"] & { cleanup(): Promise<void> } {
  let dir: string | null = null;
  const git = async (args: string[], options: { cwd?: string; allowFail?: boolean; extraEnv?: Record<string, string> } = {}) => {
    try {
      const { stdout } = await run("git", args, {
        cwd: options.cwd ?? dir ?? undefined,
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.extraEnv },
      });
      return { ok: true, stdout: stdout.trim() };
    } catch (error) {
      // No git binary at all is a deployment problem, not a repository one.
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") throw new Error("git_missing");
      if (options.allowFail) return { ok: false, stdout: "" };
      throw new Error(`git_${args[0] === "clone" ? "clone" : args[0] === "push" ? "push" : "failed"}`);
    }
  };
  // Develop pull requests merged before this one, within the Admin window, that
  // changed a file the pick conflicted on: what main most likely lacks. The
  // fetch of the merge commit brought develop's history; a failed read names none.
  const predecessors = async (pull: QaReleaseTrainCandidate, files: readonly string[]): Promise<number[]> => {
    if (files.length === 0) return [];
    const since = new Date(Date.parse(pull.mergedAt) - QA_RELEASE_TRAIN_CANDIDATE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const log = await git(["log", "--first-parent", `--since=${since}`, "--format=%s", `${pull.mergeCommitSha}^1`, "--", ...files], { allowFail: true });
    const numbers = log.stdout.split("\n").map(qaReleaseTrainMergedPullNumber).filter((n): n is number => n !== null && n !== pull.number);
    return [...new Set(numbers)].slice(0, QA_RELEASE_TRAIN_MAX_PREDECESSORS);
  };
  return {
    async assemble(branch, cargo, capacity) {
      // A round that assembles twice (an empty emergency, then the scheduled
      // train) keeps one clone: the first is removed before the second.
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = await mkdtemp(join(tmpdir(), "qa-release-train-"));
      await git(["clone", "--quiet", "--filter=blob:none", "--no-tags", "--single-branch", "--branch", "main", input.remote ?? `https://github.com/${REPOSITORY}.git`, dir], { cwd: tmpdir() });
      await git(["config", "user.name", "tomverse-qa-release-train"]);
      await git(["config", "user.email", "qa-release-train@users.noreply.github.com"]);
      const mainSha = (await git(["rev-parse", "HEAD"])).stdout;
      if (!SHA.test(mainSha)) throw new Error("git_shape");
      if (cargo.length > 0) await git(["fetch", "--quiet", "--filter=blob:none", "origin", ...cargo.map((c) => c.mergeCommitSha)]);
      await git(["switch", "--quiet", "-c", branch]);
      const picks: QaReleaseTrainPick[] = [];
      for (const pull of cargo) {
        if (picks.filter((p) => p.outcome === "included").length >= capacity) {
          picks.push({ number: pull.number, outcome: "over_capacity" });
          continue;
        }
        // Already reachable from main (a full release carried it).
        if ((await git(["merge-base", "--is-ancestor", pull.mergeCommitSha, "HEAD"], { allowFail: true })).ok) {
          picks.push({ number: pull.number, outcome: "already_in_main" });
          continue;
        }
        const before = (await git(["rev-parse", "HEAD"])).stdout;
        const picked = await git(["cherry-pick", "-m", "1", pull.mergeCommitSha], { allowFail: true });
        if (picked.ok && (await git(["rev-parse", "HEAD"])).stdout !== before) {
          // The App has no workflows permission, and GitHub refuses a push that
          // adds or changes a workflow file without it: the whole train would
          // fail. Such a pull request comes back off and is released alone.
          const touched = (await git(["diff", "--name-only", before, "HEAD"])).stdout.split("\n");
          if (touched.some((file) => file.startsWith(".github/workflows/"))) {
            await git(["reset", "--quiet", "--hard", before]);
            picks.push({ number: pull.number, outcome: "changes_workflows" });
            continue;
          }
          picks.push({ number: pull.number, outcome: "included" });
          continue;
        }
        // A pick that stopped with nothing to apply and no conflict is already on main.
        const unmerged = (await git(["diff", "--name-only", "--diff-filter=U"])).stdout;
        const staged = await git(["diff", "--cached", "--quiet"], { allowFail: true });
        if (unmerged === "" && staged.ok) {
          await git(["cherry-pick", "--skip"], { allowFail: true });
          picks.push({ number: pull.number, outcome: "already_in_main" });
        } else {
          await git(["cherry-pick", "--abort"]);
          const conflicted = unmerged.split("\n").filter((file) => file !== "");
          picks.push({ number: pull.number, outcome: "conflict", predecessors: await predecessors(pull, conflicted) });
        }
      }
      const headSha = (await git(["rev-parse", "HEAD"])).stdout;
      return { mainSha, headSha, picks };
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
      const answer = await call({ phase: "report", ...report });
      if (answer.status !== 200) throw new Error("app_report_refused");
    },
  };
}
