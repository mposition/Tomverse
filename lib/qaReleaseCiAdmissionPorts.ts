/**
 * CI admission's GitHub port (lib/qaReleaseCiAdmissionService.ts), through the
 * merge lane's App installation token. Reads: queued and running workflow
 * runs and their jobs (the repository is public, so the Actions endpoints are
 * readable with any token), open pull requests and their label events. The
 * one write is GraphQL `markPullRequestReadyForReview`. No token or body is
 * ever logged or returned: every failure is a fixed error code.
 */
import type { QaReleaseCiActiveJob, QaReleaseCiQueuedPullRequest } from "./qaReleaseCiAdmissionCore.ts";
import { QA_RELEASE_CI_QUEUED_LABEL } from "./qaReleaseCiAdmissionCore.ts";
import type { QaReleaseCiAdmissionPorts } from "./qaReleaseCiAdmissionService.ts";
import type { QaReleaseHttp } from "./qaReleaseMergeLaneGithub.ts";

const API = "https://api.github.com";
const REPO = `${API}/repos/mposition/Tomverse`;
const SHA = /^[0-9a-f]{40}$/;
/** Run statuses whose jobs hold or wait for a runner. */
const ACTIVE_RUN_STATUSES = ["queued", "in_progress", "waiting", "pending", "requested"] as const;
const ACTIVE_JOB_STATUSES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const MAX_PAGES = 3;

type Json = Record<string, unknown>;
const record = (value: unknown): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("github_shape");
  return value as Json;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("github_shape");
  return value;
};

export function createQaReleaseCiAdmissionGithubPorts(input: {
  http: QaReleaseHttp;
  token: () => Promise<string>;
}): QaReleaseCiAdmissionPorts["github"] {
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
    if (response.status !== 200) throw new Error(`github_${response.status}`);
    return JSON.parse(response.text) as unknown;
  };

  return {
    async activeJobs() {
      const runIds = new Set<number>();
      for (const status of ACTIVE_RUN_STATUSES) {
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const body = record(await request("GET", `${REPO}/actions/runs?status=${status}&per_page=100&page=${page}`));
          const runs = list(body.workflow_runs);
          for (const run of runs) {
            const id = record(run).id;
            if (typeof id === "number") runIds.add(id);
          }
          if (runs.length < 100) break;
        }
      }
      const jobs: QaReleaseCiActiveJob[] = [];
      for (const id of runIds) {
        const body = record(await request("GET", `${REPO}/actions/runs/${id}/jobs?filter=latest&per_page=100`));
        for (const job of list(body.jobs)) {
          const data = record(job);
          if (!ACTIVE_JOB_STATUSES.has(String(data.status))) continue;
          jobs.push({ headSha: String(data.head_sha ?? "") });
        }
      }
      return jobs;
    },

    async queuedPullRequests() {
      const pulls: QaReleaseCiQueuedPullRequest[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const batch = list(await request("GET", `${REPO}/pulls?state=open&per_page=100&page=${page}`));
        for (const item of batch) {
          const pull = record(item);
          const labels = list(pull.labels ?? []).map((label) => String(record(label).name ?? ""));
          if (pull.draft !== true || !labels.includes(QA_RELEASE_CI_QUEUED_LABEL)) continue;
          const number = pull.number;
          const headSha = String(record(pull.head).sha ?? "");
          if (typeof number !== "number" || !SHA.test(headSha)) continue;
          // The line's order is when the label was added, not when the pull
          // request was opened: the newest `labeled` event for it.
          const events = list(await request("GET", `${REPO}/issues/${number}/events?per_page=100`));
          const labelled = events
            .map(record)
            .filter((event) => event.event === "labeled" && record(event.label ?? {}).name === QA_RELEASE_CI_QUEUED_LABEL)
            .map((event) => String(event.created_at ?? ""))
            .filter((at) => !Number.isNaN(Date.parse(at)))
            .sort();
          pulls.push({
            number,
            nodeId: String(pull.node_id ?? ""),
            draft: true,
            labels,
            base: String(record(pull.base).ref ?? ""),
            head: String(record(pull.head).ref ?? ""),
            headSha,
            queuedAt: labelled.at(-1) ?? String(pull.created_at ?? ""),
          });
        }
        if (batch.length < 100) break;
      }
      return pulls;
    },

    async markReady(nodeId) {
      if (!/^[A-Za-z0-9_=-]{1,100}$/.test(nodeId)) throw new Error("node_id_invalid");
      const body = record(
        await request("POST", `${API}/graphql`, {
          query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
          variables: { id: nodeId },
        }),
      );
      if (body.errors !== undefined) throw new Error("github_graphql_errors");
      const isDraft = record(record(record(body.data).markPullRequestReadyForReview).pullRequest).isDraft;
      if (isDraft !== false) throw new Error("github_still_draft");
    },
  };
}
