import "server-only";

import { createSign } from "node:crypto";

import type { CiAdmissionPull } from "@/lib/ciAdmissionCore";

/**
 * CI admission's GitHub port: its own GitHub App, installed on this one
 * repository with Pull requests and Actions write, Metadata read.
 *
 * Writes, and nothing else: convert a pull request to draft, mark one ready
 * for review, cancel a pull_request workflow run of a held pull request or a
 * draft. No merge, push, label, comment or status. Every failure is a short
 * code; no token, key or body is ever returned or logged. The webhook
 * signature check is in lib/ciAdmissionWebhookCore.ts.
 */

export const CI_ADMISSION_REPOSITORY = "mposition/Tomverse";
const API = "https://api.github.com";
const REPO = `${API}/repos/${CI_ADMISSION_REPOSITORY}`;
const TIMEOUT_MS = 8_000;
const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

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

export type CiAdmissionGithub = {
  openPulls(): Promise<CiAdmissionPull[]>;
  /** Head SHAs with a pull_request workflow run queued or in progress, repository-wide. */
  runningShas(): Promise<Set<string>>;
  convertToDraft(pull: CiAdmissionPull): Promise<void>;
  markReady(pull: CiAdmissionPull): Promise<void>;
  /** Cancels the pull request's queued and running pull_request runs; returns how many. */
  cancelRuns(pull: CiAdmissionPull): Promise<number>;
  /** Jobs holding or waiting for a runner right now, repository-wide, split by GitHub-hosted and Ubicloud. */
  runnerUsage(): Promise<CiRunnerUsageCounts>;
};

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
        permissions: { pull_requests: "write", actions: "write", metadata: "read" },
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
  const pullRuns = async (pull: CiAdmissionPull) => {
    const body = record(await get(`${REPO}/actions/runs?head_sha=${pull.headSha}&event=pull_request&per_page=50`));
    return list(body.workflow_runs).map(record);
  };

  return {
    async openPulls() {
      const pulls: CiAdmissionPull[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const batch = list(await get(`${REPO}/pulls?state=open&per_page=100&page=${page}`));
        for (const item of batch) {
          const pull = record(item);
          const head = record(pull.head);
          const headRepo = head.repo === null || head.repo === undefined ? null : record(head.repo);
          if (typeof pull.number !== "number") continue;
          pulls.push({
            number: pull.number,
            nodeId: String(pull.node_id ?? ""),
            title: String(pull.title ?? ""),
            base: String(record(pull.base).ref ?? ""),
            head: String(head.ref ?? ""),
            headSha: String(head.sha ?? ""),
            draft: pull.draft === true,
            fork: headRepo === null || headRepo.full_name !== CI_ADMISSION_REPOSITORY,
          });
        }
        if (batch.length < 100) break;
      }
      return pulls;
    },
    async runningShas() {
      const shas = new Set<string>();
      for (const status of ACTIVE_RUN_STATUSES) {
        for (let page = 1; page <= 3; page += 1) {
          const runs = list(record(await get(`${REPO}/actions/runs?status=${status}&event=pull_request&per_page=100&page=${page}`)).workflow_runs);
          for (const run of runs) {
            const sha = record(run).head_sha;
            if (typeof sha === "string") shas.add(sha);
          }
          if (runs.length < 100) break;
        }
      }
      return shas;
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
      let cancelled = 0;
      for (const run of await pullRuns(pull)) {
        if (!ACTIVE_RUN_STATUSES.has(String(run.status)) || typeof run.id !== "number") continue;
        const answer = await call("POST", `${REPO}/actions/runs/${run.id}/cancel`, await installationToken());
        // 409: the run finished meanwhile; nothing left to cancel.
        if (answer.status === 202) cancelled += 1;
        else if (answer.status !== 409) throw new Error(`github_cancel_${answer.status}`);
      }
      return cancelled;
    },
  };
}
