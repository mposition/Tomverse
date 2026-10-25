import { createSign } from "node:crypto";

import {
  ciRunKey,
  ciRunnerOwnerKey,
  type CiAdmissionCheck,
  type CiAdmissionDeploy,
  type CiAdmissionPull,
  type CiRunnerOwner,
} from "@/lib/ciAdmissionCore";

/**
 * CI admission's GitHub port: its own GitHub App, installed on this one
 * repository with Pull requests, Actions and Commit statuses write, Metadata
 * read.
 *
 * Writes, and nothing else: convert a pull request to draft, mark one ready
 * for review, cancel a pull_request workflow run of a held pull request, a
 * draft or one the operator stops in Admin, and one commit status (context `CI admission`) on a pull request's
 * head telling sessions it waits in line. No merge, push, label or comment. Every failure is a short
 * code; no token, key or body is ever returned or logged. The webhook
 * signature check is in lib/ciAdmissionWebhookCore.ts.
 */

export const CI_ADMISSION_REPOSITORY = "mposition/Tomverse";
const API = "https://api.github.com";
const REPO = `${API}/repos/${CI_ADMISSION_REPOSITORY}`;
const TIMEOUT_MS = 8_000;
const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const SHA = /^[0-9a-f]{40}$/;
const RUNNER_USAGE_MAX_RUNS = 200;
const RUNNER_USAGE_PARALLEL = 8;

export type CiAdmissionGithubConfig = { appId: string; privateKey: string };

/** The App id and key from the environment, or null when either is missing. */
export function ciAdmissionGithubConfig(env: NodeJS.ProcessEnv = process.env): CiAdmissionGithubConfig | null {
  const appId = (env.CI_ADMISSION_GITHUB_APP_ID ?? "").trim();
  const privateKey = normalizeCiAdmissionPrivateKey(env.CI_ADMISSION_GITHUB_APP_PRIVATE_KEY ?? "");
  if (!/^[1-9][0-9]{0,11}$/.test(appId) || privateKey === "") return null;
  return { appId, privateKey };
}

const PEM = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/;

/**
 * The App's private key (the whole downloaded .pem, not the SHA256
 * fingerprint GitHub lists) as a PEM Node can read, however the variable
 * stored it: real newlines, literal "\n", newlines turned into spaces by a
 * single-line field, CRLF, surrounding quotes, or the whole PEM
 * base64-encoded. The body is re-wrapped at 64 characters between its own
 * header and footer. "" when nothing PEM-shaped is found -- a fingerprint
 * pasted by mistake then reads as "not configured" rather than a decoder
 * error on every round.
 */
export function normalizeCiAdmissionPrivateKey(raw: string): string {
  let text = raw.trim().replace(/^["']|["']$/g, "").replaceAll("\\n", "\n").trim();
  if (!text.includes("-----BEGIN")) {
    const decoded = Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8");
    if (decoded.includes("-----BEGIN")) text = decoded;
  }
  const match = PEM.exec(text);
  if (!match) return "";
  const lines = match[2].replace(/\s+/g, "").match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${match[1]}-----`, ...lines, `-----END ${match[1]}-----`, ""].join("\n");
}

const appJwt = (config: CiAdmissionGithubConfig, nowMs: number) => {
  const now = Math.floor(nowMs / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: config.appId })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(config.privateKey, "base64url")}`;
};

type Json = Record<string, unknown>;
const record = (value: unknown): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("github_shape");
  return value as Json;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("github_shape");
  return value;
};

/** The pull requests a workflow run is for, with their base (GitHub lists them on the run; empty for a fork's). */
const runPulls = (run: Json): { number: number; base: string | null }[] =>
  (Array.isArray(run.pull_requests) ? run.pull_requests : []).flatMap((pr) => {
    if (typeof pr !== "object" || pr === null) return [];
    const entry = pr as Json;
    if (typeof entry.number !== "number") return [];
    const base = typeof entry.base === "object" && entry.base !== null ? (entry.base as Json).ref : null;
    return [{ number: entry.number, base: typeof base === "string" ? base : null }];
  });
const runPullNumbers = (run: Json): number[] => runPulls(run).map((pr) => pr.number);

/** Whose runners an active run holds, with no jobs counted yet: its pull request, its deploy, or its workflow. */
const runnerOwner = (run: Json): CiRunnerOwner => {
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
  const sha = SHA.test(text(run.head_sha, 40)) ? text(run.head_sha, 40) : null;
  const shared = { title: text(run.display_title, 200), sha, running: 0, queued: 0, startedAt: text(run.run_started_at, 30) || text(run.created_at, 30) };
  const pull = run.event === "pull_request" ? runPulls(run)[0] : undefined;
  if (pull) return { ...shared, key: ciRunnerOwnerKey.pull(pull.number), number: pull.number, base: pull.base };
  if (run.event === "push" && sha && (run.head_branch === "develop" || run.head_branch === "main")) {
    return { ...shared, key: ciRunnerOwnerKey.deploy(run.head_branch, sha), number: null, base: run.head_branch };
  }
  const workflow = text(run.name, 100) || "workflow";
  return { ...shared, key: `other:${workflow}`, title: workflow, number: null, base: null };
};

const toPull = (item: unknown): CiAdmissionPull | null => {
  const pull = record(item);
  const head = record(pull.head);
  const headRepo = head.repo === null || head.repo === undefined ? null : record(head.repo);
  if (typeof pull.number !== "number") return null;
  return {
    number: pull.number,
    nodeId: String(pull.node_id ?? ""),
    title: String(pull.title ?? ""),
    base: String(record(pull.base).ref ?? ""),
    head: String(head.ref ?? ""),
    headSha: String(head.sha ?? ""),
    draft: pull.draft === true,
    fork: headRepo === null || headRepo.full_name !== CI_ADMISSION_REPOSITORY,
    labels: (Array.isArray(pull.labels) ? pull.labels : []).flatMap((label) =>
      typeof label === "object" && label !== null && typeof (label as Json).name === "string" ? [String((label as Json).name)] : [],
    ),
  };
};

export type CiAdmissionGithub = {
  openPulls(): Promise<CiAdmissionPull[]>;
  /**
   * `ciRunKey(number, head)` for every pull_request workflow run queued or in
   * progress, repository-wide, and the push runs on develop and main (one
   * entry per commit).
   */
  runningPulls(): Promise<{ keys: Set<string>; bases: Map<number, string>; deploys: CiAdmissionDeploy[] }>;
  /** One pull request as GitHub shows it now, with whether it is open; null when there is none. */
  pull(number: number): Promise<{ pull: CiAdmissionPull; open: boolean } | null>;
  /**
   * Whether a draft conflicts with its base (GitHub's `mergeable`, which may
   * still be computing: null) and whether its base has commits it lacks
   * (null when the comparison cannot be read).
   */
  check(pull: CiAdmissionPull): Promise<CiAdmissionCheck>;
  convertToDraft(pull: CiAdmissionPull): Promise<void>;
  markReady(pull: CiAdmissionPull): Promise<void>;
  /**
   * Cancels the pull request's own queued and running pull_request runs (never
   * another pull request's on the same commit); returns how many. `force` is
   * GitHub's force-cancel, which also stops jobs that run on cancellation:
   * the operator's stop, not admission's own holds.
   */
  cancelRuns(pull: CiAdmissionPull, options?: { force?: boolean }): Promise<number>;
  /** Who holds or waits for a GitHub-hosted runner right now, repository-wide: each pull request, deploy and other workflow. */
  runnerUsage(): Promise<CiRunnerOwner[]>;
  /** The `CI admission` commit status on the pull request's head. */
  setStatus(sha: string, state: "pending" | "success", description: string): Promise<void>;
  /**
   * GET one path under the repository's API (`/pulls?...`, `/commits/main`)
   * with a read-only token, for Admin pages that show the repository; throws
   * `github_<status>`.
   */
  readRepo(path: string): Promise<unknown>;
};

export const CI_ADMISSION_STATUS_CONTEXT = "CI admission";

export function createCiAdmissionGithub(config: CiAdmissionGithubConfig, now: () => number = Date.now): CiAdmissionGithub {
  const call = async (method: "GET" | "POST", url: string, auth: string, body?: Json) => {
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${auth}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    const text = await response.text();
    return { status: response.status, json: () => JSON.parse(text) as unknown };
  };

  const tokens = new Map<string, Promise<string>>();
  let compareAvailable = true;
  const ADMISSION_PERMISSIONS = { pull_requests: "write", actions: "write", statuses: "write", metadata: "read" };
  const installationToken = (permissions: Record<string, string> = ADMISSION_PERMISSIONS): Promise<string> => {
    const key = JSON.stringify(permissions);
    const existing = tokens.get(key);
    if (existing) return existing;
    const created = (async () => {
      const jwt = appJwt(config, now());
      const installation = await call("GET", `${REPO}/installation`, jwt);
      if (installation.status !== 200) throw new Error(`github_installation_${installation.status}`);
      const id = record(installation.json()).id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("github_shape");
      const answer = await call("POST", `${API}/app/installations/${id}/access_tokens`, jwt, {
        repositories: [CI_ADMISSION_REPOSITORY.split("/")[1]],
        permissions,
      });
      if (answer.status !== 201) throw new Error(`github_token_${answer.status}`);
      const value = record(answer.json()).token;
      if (typeof value !== "string" || value === "") throw new Error("github_shape");
      return value;
    })().catch((error) => {
      tokens.delete(key);
      throw error;
    });
    tokens.set(key, created);
    return created;
  };

  const get = async (url: string) => {
    const answer = await call("GET", url, await installationToken());
    if (answer.status !== 200) throw new Error(`github_${answer.status}`);
    return answer.json();
  };
  const graphql = async (mutation: string, id: string) => {
    if (!/^[A-Za-z0-9_=-]{1,100}$/.test(id)) throw new Error("node_id_invalid");
    const answer = await call("POST", `${API}/graphql`, await installationToken(), { query: mutation, variables: { id } });
    if (answer.status !== 200) throw new Error(`github_graphql_${answer.status}`);
    const body = record(answer.json());
    if (body.errors !== undefined) {
      // GitHub's error type (FORBIDDEN, NOT_FOUND ...) says what to fix; its
      // message is free text and is not kept. 2026-10-23: every release failed
      // as a bare "github_graphql_errors" and nobody could tell why.
      const first = Array.isArray(body.errors) && body.errors.length > 0 ? record(body.errors[0]) : {};
      const type = typeof first.type === "string" && /^[A-Z_]{1,40}$/.test(first.type) ? first.type : "UNKNOWN";
      throw new Error(`github_graphql_errors:${type}`);
    }
    return record(body.data);
  };
  return {
    async setStatus(sha, state, description) {
      if (!SHA.test(sha)) throw new Error("head_sha_invalid");
      const target = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
      const answer = await call("POST", `${REPO}/statuses/${sha}`, await installationToken(), {
        state,
        context: CI_ADMISSION_STATUS_CONTEXT,
        description: description.slice(0, 140),
        ...(/^https:\/\//.test(target) ? { target_url: `${target}/admin/qa-release?tab=ci-admission` } : {}),
      });
      if (answer.status !== 201) throw new Error(`github_status_${answer.status}`);
    },
    async openPulls() {
      const pulls: CiAdmissionPull[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const batch = list(await get(`${REPO}/pulls?state=open&per_page=100&page=${page}`));
        for (const item of batch) {
          const pull = toPull(item);
          if (pull) pulls.push(pull);
        }
        if (batch.length < 100) break;
      }
      return pulls;
    },
    async runningPulls() {
      const keys = new Set<string>();
      // The base of each pull request with a run, so a closed or merged one
      // whose runs still run is counted at its slots too.
      const bases = new Map<number, string>();
      // Deploy CI: push runs on develop and main, one entry per commit.
      const deploys = new Map<string, CiAdmissionDeploy>();
      for (const status of ACTIVE_RUN_STATUSES) {
        for (let page = 1; page <= 3; page += 1) {
          const runs = list(record(await get(`${REPO}/actions/runs?status=${status}&per_page=100&page=${page}`)).workflow_runs);
          for (const run of runs) {
            const data = record(run);
            if (typeof data.head_sha !== "string") continue;
            if (data.event === "pull_request") {
              for (const { number, base } of runPulls(data)) {
                keys.add(ciRunKey(number, data.head_sha));
                if (base) bases.set(number, base);
              }
            } else if (data.event === "push" && (data.head_branch === "develop" || data.head_branch === "main")) {
              const key = `${data.head_branch}@${data.head_sha}`;
              if (!deploys.has(key)) {
                const title = typeof data.display_title === "string" ? data.display_title : "";
                deploys.set(key, { branch: data.head_branch, sha: data.head_sha.slice(0, 40), title: title.slice(0, 200) });
              }
            }
          }
          if (runs.length < 100) break;
        }
      }
      return { keys, bases, deploys: [...deploys.values()] };
    },
    async pull(number) {
      const answer = await call("GET", `${REPO}/pulls/${number}`, await installationToken());
      if (answer.status === 404) return null;
      if (answer.status !== 200) throw new Error(`github_${answer.status}`);
      const body = answer.json();
      const pull = toPull(body);
      return pull ? { pull, open: record(body).state === "open" } : null;
    },
    async check(pull) {
      const detail = await call("GET", `${REPO}/pulls/${pull.number}`, await installationToken());
      if (detail.status !== 200) throw new Error(`github_${detail.status}`);
      const mergeable = record(detail.json()).mergeable;
      const conflict = mergeable === false ? true : mergeable === true ? false : null;
      let behind: boolean | null = null;
      if (compareAvailable && SHA.test(pull.headSha) && /^[A-Za-z0-9._/-]{1,100}$/.test(pull.base)) {
        try {
          const compare = await call(
            "GET",
            `${REPO}/compare/${encodeURIComponent(pull.base)}...${pull.headSha}`,
            await installationToken({ contents: "read", metadata: "read" }),
          );
          if (compare.status === 200) {
            const behindBy = record(compare.json()).behind_by;
            if (typeof behindBy === "number") behind = behindBy > 0;
          }
        } catch {
          // No contents permission (the token is refused) or the read failed:
          // behind stays unknown, and this client stops asking.
          compareAvailable = false;
        }
      }
      return { conflict, behind };
    },
    async convertToDraft(pull) {
      const data = await graphql(
        "mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
        pull.nodeId,
      );
      if (record(record(data.convertPullRequestToDraft).pullRequest).isDraft !== true) throw new Error("github_not_draft");
    },
    async markReady(pull) {
      const data = await graphql(
        "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
        pull.nodeId,
      );
      if (record(record(data.markPullRequestReadyForReview).pullRequest).isDraft !== false) throw new Error("github_still_draft");
    },
    async readRepo(path) {
      if (!path.startsWith("/") || path.includes("..")) throw new Error("github_path");
      const answer = await call("GET", `${REPO}${path}`, await installationToken({ contents: "read", pull_requests: "read", metadata: "read" }));
      if (answer.status !== 200) throw new Error(`github_${answer.status}`);
      return answer.json();
    },
    async runnerUsage() {
      const runs = new Map<number, Json>();
      for (const status of ACTIVE_RUN_STATUSES) {
        for (let page = 1; page <= 3; page += 1) {
          const batch = list(record(await get(`${REPO}/actions/runs?status=${status}&per_page=100&page=${page}`)).workflow_runs).map(record);
          for (const run of batch) if (typeof run.id === "number") runs.set(run.id, run);
          if (batch.length < 100) break;
        }
      }
      // Bounded, so a busy repository still answers within a few seconds: at
      // most RUNNER_USAGE_MAX_RUNS runs, RUNNER_USAGE_PARALLEL job reads at a time.
      const owners = new Map<string, CiRunnerOwner>();
      const active = [...runs.values()].slice(0, RUNNER_USAGE_MAX_RUNS);
      for (let index = 0; index < active.length; index += RUNNER_USAGE_PARALLEL) {
        const batch = active.slice(index, index + RUNNER_USAGE_PARALLEL);
        const jobLists = await Promise.all(batch.map(async (run) => list(record(await get(`${REPO}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs)));
        batch.forEach((run, at) => {
          const owner = runnerOwner(run);
          const entry = owners.get(owner.key) ?? owner;
          if (entry.startedAt < owner.startedAt) entry.startedAt = owner.startedAt;
          for (const item of jobLists[at]) {
            const job = record(item);
            const status = String(job.status);
            const labels = Array.isArray(job.labels) ? job.labels.map(String) : [];
            // Ubicloud jobs are outside GitHub's limit.
            if (!ACTIVE_RUN_STATUSES.has(status) || labels.some((label) => label.startsWith("ubicloud"))) continue;
            if (status === "in_progress") entry.running += 1;
            else entry.queued += 1;
          }
          owners.set(entry.key, entry);
        });
      }
      return [...owners.values()];
    },
    async cancelRuns(pull, options = {}) {
      // Every queued or running pull_request run of this pull request, on any
      // head (a re-run of an older head's run included), and no other's -- the
      // same commit may be the head of another pull request too.
      const runs: Json[] = [];
      for (const status of ACTIVE_RUN_STATUSES) {
        for (let page = 1; page <= 3; page += 1) {
          const batch = list(record(await get(`${REPO}/actions/runs?status=${status}&event=pull_request&per_page=100&page=${page}`)).workflow_runs).map(record);
          runs.push(...batch.filter((run) => runPullNumbers(run).includes(pull.number)));
          if (batch.length < 100) break;
        }
      }
      let cancelled = 0;
      for (const run of runs) {
        if (typeof run.id !== "number") continue;
        const answer = await call("POST", `${REPO}/actions/runs/${run.id}/${options.force ? "force-cancel" : "cancel"}`, await installationToken());
        // 409: the run finished meanwhile; nothing left to cancel.
        if (answer.status === 202) cancelled += 1;
        else if (answer.status !== 409) throw new Error(`github_cancel_${answer.status}`);
      }
      return cancelled;
    },
  };
}
