import { createSign } from "node:crypto";

import { ciRunKey, type CiAdmissionPull } from "@/lib/ciAdmissionCore";

/**
 * CI admission's GitHub port: its own GitHub App, installed on this one
 * repository with Pull requests, Actions and Commit statuses write, Metadata
 * read.
 *
 * Writes, and nothing else: convert a pull request to draft, mark one ready
 * for review, cancel a pull_request workflow run of a held pull request or a
 * draft, and one commit status (context `CI admission`) on a pull request's
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

export type CiAdmissionGithubConfig = { appId: string; privateKey: string };

/** The App id and key from the environment, or null when either is missing. */
export function ciAdmissionGithubConfig(env: NodeJS.ProcessEnv = process.env): CiAdmissionGithubConfig | null {
  const appId = (env.CI_ADMISSION_GITHUB_APP_ID ?? "").trim();
  const raw = env.CI_ADMISSION_GITHUB_APP_PRIVATE_KEY ?? "";
  // A PEM pasted into a single-line variable arrives with literal "\n".
  const privateKey = raw.includes("\n") ? raw : raw.replaceAll("\\n", "\n");
  if (!/^[1-9][0-9]{0,11}$/.test(appId) || privateKey.trim() === "") return null;
  return { appId, privateKey };
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
  };
};

export type CiAdmissionGithub = {
  openPulls(): Promise<CiAdmissionPull[]>;
  /** `ciRunKey(number, head)` for every pull_request workflow run queued or in progress, repository-wide. */
  runningPulls(): Promise<{ keys: Set<string>; bases: Map<number, string> }>;
  convertToDraft(pull: CiAdmissionPull): Promise<void>;
  markReady(pull: CiAdmissionPull): Promise<void>;
  /** Cancels the pull request's own queued and running pull_request runs (never another pull request's on the same commit); returns how many. */
  cancelRuns(pull: CiAdmissionPull): Promise<number>;
  /** Jobs holding or waiting for a runner right now, repository-wide, split by GitHub-hosted and Ubicloud. */
  runnerUsage(): Promise<CiRunnerUsageCounts>;
  /** The `CI admission` commit status on the pull request's head. */
  setStatus(sha: string, state: "pending" | "success", description: string): Promise<void>;
};

export const CI_ADMISSION_STATUS_CONTEXT = "CI admission";

export type CiRunnerUsageCounts = { githubRunning: number; githubQueued: number; ubicloudRunning: number; ubicloudQueued: number };

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

  let token: Promise<string> | null = null;
  const installationToken = () =>
    (token ??= (async () => {
      const jwt = appJwt(config, now());
      const installation = await call("GET", `${REPO}/installation`, jwt);
      if (installation.status !== 200) throw new Error(`github_installation_${installation.status}`);
      const id = record(installation.json()).id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("github_shape");
      const created = await call("POST", `${API}/app/installations/${id}/access_tokens`, jwt, {
        repositories: [CI_ADMISSION_REPOSITORY.split("/")[1]],
        permissions: { pull_requests: "write", actions: "write", statuses: "write", metadata: "read" },
      });
      if (created.status !== 201) throw new Error(`github_token_${created.status}`);
      const value = record(created.json()).token;
      if (typeof value !== "string" || value === "") throw new Error("github_shape");
      return value;
    })().catch((error) => {
      token = null;
      throw error;
    }));

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
    if (body.errors !== undefined) throw new Error("github_graphql_errors");
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
        ...(/^https:\/\//.test(target) ? { target_url: `${target}/admin/agent-digests` } : {}),
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
      for (const status of ACTIVE_RUN_STATUSES) {
        for (let page = 1; page <= 3; page += 1) {
          const runs = list(record(await get(`${REPO}/actions/runs?status=${status}&event=pull_request&per_page=100&page=${page}`)).workflow_runs);
          for (const run of runs) {
            const data = record(run);
            if (typeof data.head_sha !== "string") continue;
            for (const { number, base } of runPulls(data)) {
              keys.add(ciRunKey(number, data.head_sha));
              if (base) bases.set(number, base);
            }
          }
          if (runs.length < 100) break;
        }
      }
      return { keys, bases };
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
    async runnerUsage() {
      const runIds = new Set<number>();
      for (const status of ACTIVE_RUN_STATUSES) {
        for (let page = 1; page <= 3; page += 1) {
          const runs = list(record(await get(`${REPO}/actions/runs?status=${status}&per_page=100&page=${page}`)).workflow_runs);
          for (const run of runs) {
            const id = record(run).id;
            if (typeof id === "number") runIds.add(id);
          }
          if (runs.length < 100) break;
        }
      }
      const counts: CiRunnerUsageCounts = { githubRunning: 0, githubQueued: 0, ubicloudRunning: 0, ubicloudQueued: 0 };
      for (const id of runIds) {
        for (const item of list(record(await get(`${REPO}/actions/runs/${id}/jobs?filter=latest&per_page=100`)).jobs)) {
          const job = record(item);
          const status = String(job.status);
          if (!ACTIVE_RUN_STATUSES.has(status)) continue;
          const labels = Array.isArray(job.labels) ? job.labels.map(String) : [];
          const ubicloud = labels.some((label) => label.startsWith("ubicloud"));
          const running = status === "in_progress";
          if (ubicloud) counts[running ? "ubicloudRunning" : "ubicloudQueued"] += 1;
          else counts[running ? "githubRunning" : "githubQueued"] += 1;
        }
      }
      return counts;
    },
    async cancelRuns(pull) {
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
        const answer = await call("POST", `${REPO}/actions/runs/${run.id}/cancel`, await installationToken());
        // 409: the run finished meanwhile; nothing left to cancel.
        if (answer.status === 202) cancelled += 1;
        else if (answer.status !== 409) throw new Error(`github_cancel_${answer.status}`);
      }
      return cancelled;
    },
  };
}
