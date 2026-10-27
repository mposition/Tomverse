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
  QA_RELEASE_TRAIN_MAX_PREDECESSORS,
  QA_RELEASE_TRAIN_REPOSITORY,
  qaReleaseTrainIncludedNumbers,
  qaReleaseTrainIsTrainPull,
  qaReleaseTrainMergedPullNumber,
  qaReleaseTrainSettleAdjacent,
  type QaReleaseTrainCandidate,
  type QaReleaseTrainPick,
} from "./qaReleaseTrainCore.ts";
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

/** How deep a conflict's predecessors are followed: a predecessor that conflicts in turn may board its own, this many levels down. */
const BOARDING_DEPTH = 3;
/** At most this many of a conflict's files are blamed for its predecessors. */
const BLAMED_FILES = 20;
/** File versions fetched at once before a blame: a partial clone would fetch each alone. */
const BLAMED_VERSIONS = 500;
/** The commit trailer naming the files of a settled adjacent-line conflict. */
const SETTLED_TRAILER = "Release-train-settled";
/** A line git would read as a conflict marker: a file holding one is never settled. */
const MARKER_LINE = /^(<{7}|\|{7}|>{7})( |$)|^={7}$/m;

/**
 * `remote` is for tests only: a local repository path stands in for GitHub,
 * and the push goes to it without a token. `autoPredecessors` (owner,
 * 2026-10-27; on unless `QA_RELEASE_TRAIN_AUTO_PREDECESSORS=false`): a pick
 * that conflicts boards the develop pull requests it needs first.
 */
export function createQaReleaseTrainGitPorts(input: {
  token: () => Promise<string>;
  remote?: string;
  autoPredecessors?: boolean;
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
  // The develop pull requests that wrote what a conflicting pick needs and
  // main lacks, newest first (2026-10-27: "changed a conflicted file in the
  // last 14 days" named ten unrelated package.json pull requests for #3042 and
  // missed the cause, #2131). For each conflicted file, the lines the pick's
  // change was made against (its diff's old side, context included) are
  // blamed along develop's merges; a line main's file also has is not the
  // cause. The fetch of the merge commit brought develop's history; a failed
  // read names none. Each comes with its merge commit, so it can board.
  const predecessors = async (pull: QaReleaseTrainCandidate, files: readonly string[]): Promise<QaReleaseTrainCandidate[]> => {
    const parent = `${pull.mergeCommitSha}^1`;
    const causes = new Set<string>();
    for (const file of files.slice(0, BLAMED_FILES)) {
      const diff = await git(["diff", "-U3", "--no-color", "--no-ext-diff", parent, pull.mergeCommitSha, "--", file], { allowFail: true });
      const ranges = [...diff.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? /gm)].map((m) => ({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) })).filter((r) => r.count > 0);
      if (ranges.length === 0) continue;
      const versions = await git(["log", "--first-parent", "--diff-merges=first-parent", "--format=", "--raw", "--no-abbrev", "-n", String(BLAMED_VERSIONS), parent, "--", file], { allowFail: true });
      const blobs = [...new Set([...versions.stdout.matchAll(/^:\d+ \d+ [0-9a-f]{40} ([0-9a-f]{40}) /gm)].map((m) => m[1]))].filter((blob) => !/^0+$/.test(blob));
      if (blobs.length > 0) await git(["-c", "fetch.negotiationAlgorithm=noop", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--filter=blob:none", "origin", ...blobs], { allowFail: true });
      const blame = await git(["blame", "--first-parent", "--porcelain", ...ranges.flatMap((r) => ["-L", `${r.start},+${r.count}`]), parent, "--", file], { allowFail: true, raw: true });
      const onMain = new Set((await git(["show", `HEAD:${file}`], { allowFail: true, raw: true })).stdout.split("\n"));
      let commit = "";
      for (const line of blame.stdout.split("\n")) {
        const header = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
        if (header) commit = header[1];
        else if (line.startsWith("\t") && !onMain.has(line.slice(1))) causes.add(commit);
      }
    }
    const found = new Map<number, QaReleaseTrainCandidate>();
    for (const sha of causes) {
      // GitHub's merge commit: subject "Merge pull request #N from ...", body's first line the pull request's title.
      const [mergedAt = "", subject = "", body = ""] = (await git(["log", "-1", "--format=%cI%x1f%s%x1f%b", sha], { allowFail: true })).stdout.split("\x1f");
      const number = qaReleaseTrainMergedPullNumber(subject);
      if (number === null || number === pull.number || found.has(number) || !SHA.test(sha)) continue;
      found.set(number, { number, title: body.split("\n")[0].trim(), mergeCommitSha: sha, mergedAt: mergedAt || pull.mergedAt });
    }
    return [...found.values()].sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)).slice(0, QA_RELEASE_TRAIN_MAX_PREDECESSORS);
  };
  // A stopped pick whose every conflict is adjacent lines
  // (qaReleaseTrainSettleAdjacent) is settled in the working tree and staged;
  // false leaves the rest to the caller's abort.
  const settleAdjacent = async (files: readonly string[]): Promise<boolean> => {
    // A name the trailer cannot carry as one item is not settled.
    if (!dir || files.length === 0 || files.some((file) => /[,\r\n]/.test(file))) return false;
    for (const file of files) {
      // Only a regular file on all three sides: one changed on one side and
      // deleted on the other, a symlink or a submodule is not settled.
      const stages = (await git(["ls-files", "-u", "--", file], { allowFail: true })).stdout.split("\n").filter((row) => row !== "");
      if (stages.length !== 3 || !stages.every((row) => /^100(644|755) [0-9a-f]{40} [123]\t/.test(row))) return false;
      // Nor a binary one (git leaves it without markers) or one holding marker-like lines.
      for (const stage of [1, 2, 3]) {
        const side = await git(["show", `:${stage}:${file}`], { allowFail: true, raw: true });
        if (!side.ok || side.stdout.includes("\0") || MARKER_LINE.test(side.stdout)) return false;
      }
      if (!(await git(["checkout", "--conflict=diff3", "--", file], { allowFail: true })).ok) return false;
      const lines = (await readFile(join(dir, file), "utf8")).split("\n");
      const settled: string[] = [];
      let hunks = 0;
      for (let i = 0; i < lines.length; ) {
        if (!lines[i].startsWith("<<<<<<< ")) {
          settled.push(lines[i++]);
          continue;
        }
        const hunk = { main: [] as string[], base: [] as string[], pick: [] as string[] };
        let side = hunk.main;
        for (i++; i < lines.length && !lines[i].startsWith(">>>>>>> "); i++) {
          if (lines[i].startsWith("||||||| ") && side === hunk.main) side = hunk.base;
          else if (lines[i] === "=======" && side === hunk.base) side = hunk.pick;
          else side.push(lines[i]);
        }
        // An unclosed hunk, or one without all three sides, is not read.
        if (i++ >= lines.length || side !== hunk.pick) return false;
        const resolved = qaReleaseTrainSettleAdjacent(hunk);
        if (resolved === null) return false;
        settled.push(...resolved);
        hunks++;
      }
      // A conflicted file with no hunk to read is one git could not mark: never staged as main's.
      if (hunks === 0) return false;
      await writeFile(join(dir, file), settled.join("\n"));
      await git(["add", "--", file]);
    }
    return true;
  };
  type Attempt = { result: "applied" | "empty" | "workflows" } | { result: "conflict"; files: string[] };
  // One cherry-pick onto the train branch; whatever it does not keep is undone.
  const pickOnce = async (sha: string): Promise<Attempt> => {
    const before = (await git(["rev-parse", "HEAD"])).stdout;
    let picked = (await git(["cherry-pick", "-m", "1", sha], { allowFail: true })).ok;
    if (!picked) {
      // A pick that stopped with nothing to apply and no conflict is already on main.
      const unmerged = (await git(["diff", "--name-only", "--diff-filter=U"])).stdout;
      const staged = await git(["diff", "--cached", "--quiet"], { allowFail: true });
      if (unmerged === "" && staged.ok) {
        await git(["cherry-pick", "--skip"], { allowFail: true });
        return { result: "empty" };
      }
      const files = unmerged.split("\n").filter((file) => file !== "");
      picked = await settleAdjacent(files);
      // Settled to nothing new: main already had what it adds.
      if (picked && (await git(["diff", "--cached", "--quiet"], { allowFail: true })).ok) {
        await git(["cherry-pick", "--skip"], { allowFail: true });
        return { result: "empty" };
      }
      // Settled, it commits with the original message and a trailer naming the files.
      picked = picked && (await git(["commit", "--quiet", "--no-edit", "--trailer", `${SETTLED_TRAILER}: ${files.join(", ")}`], { allowFail: true })).ok;
      if (!picked) {
        await git(["cherry-pick", "--abort"]);
        return { result: "conflict", files };
      }
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
  /**
   * A pick, and when it conflicts, the develop pull requests it needs boarded
   * first (oldest first, each the same way, BOARDING_DEPTH levels down), then
   * the pick again. Short of the pick riding in the end, everything is undone:
   * the branch is as before and nothing boarded. `seats` is how many may still
   * ride, the pick included; `aboard` is what already rides. A predecessor
   * riding an open train (`elsewhere`) is never boarded a second time: the
   * pick that needs it waits for that train instead.
   */
  const board = async (
    pull: QaReleaseTrainCandidate,
    depth: number,
    seats: number,
    aboard: ReadonlySet<number>,
    elsewhere: ReadonlySet<number>,
  ): Promise<{ result: "applied"; boarded: QaReleaseTrainCandidate[] } | { result: "empty" } | { result: "workflows" } | { result: "conflict"; files: string[] }> => {
    const first = await pickOnce(pull.mergeCommitSha);
    if (first.result !== "conflict") return first.result === "applied" ? { result: "applied", boarded: [] } : { result: first.result };
    if (input.autoPredecessors === false || depth >= BOARDING_DEPTH) return first;
    const mark = (await git(["rev-parse", "HEAD"])).stdout;
    const boarded: QaReleaseTrainCandidate[] = [];
    const undo = async () => {
      await git(["reset", "--quiet", "--hard", mark]);
      return first;
    };
    const needed = (await predecessors(pull, first.files)).filter((p) => !aboard.has(p.number)).reverse();
    for (const needs of needed) {
      // Already reachable from main: nothing to board.
      if ((await git(["merge-base", "--is-ancestor", needs.mergeCommitSha, "HEAD"], { allowFail: true })).ok) continue;
      if (elsewhere.has(needs.number)) return undo();
      const taken = new Set([...aboard, ...boarded.map((b) => b.number), pull.number]);
      const ride = await board(needs, depth + 1, Math.max(seats - 1 - boarded.length, 0), taken, elsewhere);
      // One with nothing to apply (main has its change) takes no seat.
      if (ride.result === "empty") continue;
      if (ride.result !== "applied") return undo();
      boarded.push(...ride.boarded, needs);
      // The pick itself needs a seat too.
      if (boarded.length + 1 > seats) return undo();
    }
    if (boarded.length === 0) return undo();
    const again = await pickOnce(pull.mergeCommitSha);
    // Nothing left to apply: what it carries came with its predecessors, so it rides with them.
    if (again.result === "applied" || again.result === "empty") return { result: "applied", boarded };
    // A workflow change is released on its own, predecessors or not.
    if (again.result === "workflows") {
      await undo();
      return { result: "workflows" };
    }
    return undo();
  };
  return {
    async assemble(branch, cargo, capacity, onOpenTrains = []) {
      const elsewhere = new Set(onOpenTrains);
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
      const boarded: QaReleaseTrainCandidate[] = [];
      const riding = () => picks.filter((p) => p.outcome === "included").length;
      const picked = new Set(cargo.map((c) => c.number));
      for (const pull of cargo) {
        // Boarded earlier for a later pick's sake (cargo is in develop merge
        // order, so only when it was left out first): it rides already.
        if (picks.some((p) => p.number === pull.number)) continue;
        if (riding() >= capacity) {
          picks.push({ number: pull.number, outcome: "over_capacity" });
          continue;
        }
        // Already reachable from main (a full release carried it).
        if ((await git(["merge-base", "--is-ancestor", pull.mergeCommitSha, "HEAD"], { allowFail: true })).ok) {
          picks.push({ number: pull.number, outcome: "already_in_main" });
          continue;
        }
        const aboard = new Set(picks.filter((p) => p.outcome === "included").map((p) => p.number));
        const ride = await board(pull, 0, capacity - riding(), aboard, elsewhere);
        if (ride.result === "applied") {
          for (const needs of ride.boarded) {
            // A pick left out earlier in this train rides now as a predecessor:
            // the operator's own, so no boardedFor.
            const earlier = picks.findIndex((p) => p.number === needs.number);
            if (earlier !== -1) picks.splice(earlier, 1);
            picks.push(picked.has(needs.number) ? { number: needs.number, outcome: "included" } : { number: needs.number, outcome: "included", boardedFor: pull.number });
            if (!picked.has(needs.number)) boarded.push(needs);
          }
          picks.push({ number: pull.number, outcome: "included" });
        } else if (ride.result === "workflows") {
          picks.push({ number: pull.number, outcome: "changes_workflows" });
        } else if (ride.result === "empty") {
          picks.push({ number: pull.number, outcome: "already_in_main" });
        } else {
          picks.push({ number: pull.number, outcome: "conflict", predecessors: (await predecessors(pull, ride.files)).map((p) => p.number) });
        }
      }
      const headSha = (await git(["rev-parse", "HEAD"])).stdout;
      // What rides settled, read off the branch itself: an attempt undone took its commit with it.
      const settled: { number: number; files: string[] }[] = [];
      for (const entry of (await git(["log", "--format=%s%x1f%b%x1e", `${mainSha}..HEAD`])).stdout.split("\x1e")) {
        const [subject = "", body = ""] = entry.trim().split("\x1f");
        const number = qaReleaseTrainMergedPullNumber(subject);
        const trailer = new RegExp(`^${SETTLED_TRAILER}: (.+)$`, "m").exec(body);
        if (number !== null && trailer) settled.push({ number, files: trailer[1].split(", ").filter((file) => file !== "") });
      }
      return { mainSha, headSha, picks, boarded, settled };
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
        // An app older than boarded predecessors refuses `boardedFor` (400:
        // nothing was written). Sent again without it, the report still lands.
        if (!(error instanceof Error && error.message === "app_400") || !report.picks.some((p) => p.boardedFor !== undefined)) throw error;
        answer = await send(
          report.picks.map((pick) => {
            const plain = { ...pick };
            delete plain.boardedFor;
            return plain;
          }),
        );
      }
      if (answer.status !== 200) throw new Error("app_report_refused");
    },
  };
}
