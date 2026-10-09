/**
 * The merge lane service's GitHub port (docs/policy/qa-release-agent.md
 * version 4, sections 3 and 8): GitHub App authentication and the reads and
 * the one write the round needs.
 *
 * The only write is the pull request merge API with `sha` pinned to the head
 * the app's instruction names. There is no base argument -- the merge API
 * merges into the pull request's own base, which the round has just re-read
 * as develop, and the GitHub rulesets keep the App off every other branch
 * (section 8 item 7). No direct push, no ref update, no other write: a static
 * test holds this file to that.
 *
 * Network access is the injected `http` function, so every call is tested
 * without a network. An answer that is not the expected shape is an error,
 * never a guess; the round turns errors into "unknown" and does not retry.
 */
import { createSign } from "node:crypto";

import type { QaReleaseLanePullRequest } from "./qaReleaseMergeLaneCandidateCore.ts";
import { type QaReleaseChangedFile, type QaReleaseExclusionInput, QA_RELEASE_MIGRATION_SQL_PATH } from "./qaReleaseMergeLaneExclusionCore.ts";
import { isQaReleasePolicyDocument, qaReleaseAgentOwnPatterns, qaReleasePolicyTestPaths } from "./qaReleaseMergeLanePolicyInputsCore.ts";
import type { QaReleaseMergeCall, QaReleaseMergeLanePorts, QaReleasePullRead } from "./qaReleaseMergeLaneServiceCore.ts";

export const QA_RELEASE_GITHUB_API = "https://api.github.com";
export const QA_RELEASE_REPOSITORY = Object.freeze({ owner: "mposition", name: "Tomverse" });
const REPO_PATH = `/repos/${QA_RELEASE_REPOSITORY.owner}/${QA_RELEASE_REPOSITORY.name}`;
const POLICY_PATH = "docs/policy/qa-release-agent.md";

/** The installation token's permissions: section 3's list and nothing wider. */
export const QA_RELEASE_APP_TOKEN_PERMISSIONS = Object.freeze({
  contents: "write",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
  metadata: "read",
});

export type QaReleaseHttpRequest = {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers: Record<string, string>;
  body?: string;
};
export type QaReleaseHttp = (request: QaReleaseHttpRequest) => Promise<{ status: number; text: string }>;

const SHA = /^[0-9a-f]{40}$/;
/** GitHub lists at most 3,000 files for a pull request; a larger one is never complete. */
const MAX_FILE_PAGES = 30;
const MAX_PULL_PAGES = 4;

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** The App's RS256 JWT: issued a minute back for clock skew, valid nine minutes (GitHub's limit is ten). */
export function qaReleaseAppJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  if (!/^[1-9][0-9]{0,11}$/.test(appId)) throw new Error("github_app_id_invalid");
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKeyPem))}`;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("github_body_unreadable");
  }
};

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("github_shape");
  return value as Record<string, unknown>;
};
const str = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("github_shape");
  return value;
};

/**
 * An installation token for this one repository with section 3's permissions,
 * obtained once per round and reused by every call in it.
 */
export function qaReleaseInstallationToken(http: QaReleaseHttp, appId: string, privateKeyPem: string, now: () => number) {
  let token: Promise<string> | null = null;
  const fetchToken = async () => {
    const jwt = qaReleaseAppJwt(appId, privateKeyPem, now());
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "x-github-api-version": "2022-11-28",
    };
    const installation = await http({ method: "GET", url: `${QA_RELEASE_GITHUB_API}${REPO_PATH}/installation`, headers });
    if (installation.status !== 200) throw new Error(`github_installation_${installation.status}`);
    const id = record(parseJson(installation.text)).id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("github_shape");
    const created = await http({
      method: "POST",
      url: `${QA_RELEASE_GITHUB_API}/app/installations/${id}/access_tokens`,
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ repositories: [QA_RELEASE_REPOSITORY.name], permissions: QA_RELEASE_APP_TOKEN_PERMISSIONS }),
    });
    if (created.status !== 201) throw new Error(`github_token_${created.status}`);
    return str(record(parseJson(created.text)).token);
  };
  return () => {
    token ??= fetchToken();
    return token;
  };
}

const PULL_FIELDS = `
  number createdAt baseRefName headRefName headRefOid isDraft mergeable state
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on CheckRun { name status conclusion checkSuite { workflowRun { workflow { name } } } }
      ... on StatusContext { context state }
    }
  } } } } }`;

/**
 * The check rollup in the merge train's shape (what `gh pr list --json
 * statusCheckRollup` gives). A rollup with more contexts than one page holds
 * is not read past its first page: it becomes one failing context, so the
 * pull request is skipped rather than judged on part of its checks.
 */
function rollupOf(pull: Record<string, unknown>): unknown[] {
  const commits = record(pull.commits).nodes;
  if (!Array.isArray(commits)) throw new Error("github_shape");
  if (commits.length === 0) return [];
  const rollup = record(record(commits[0]).commit).statusCheckRollup;
  if (rollup === null) return [];
  const contexts = record(record(rollup).contexts);
  if (record(contexts.pageInfo).hasNextPage !== false) return [{ __typename: "StatusContext", context: "unread", state: "ERROR" }];
  if (!Array.isArray(contexts.nodes)) throw new Error("github_shape");
  return contexts.nodes.map((raw) => {
    const node = record(raw);
    if (node.__typename === "CheckRun") {
      const run = node.checkSuite === null ? null : record(node.checkSuite).workflowRun;
      const workflow = run === null || run === undefined ? null : record(run).workflow;
      return {
        __typename: "CheckRun",
        name: str(node.name),
        status: str(node.status),
        conclusion: node.conclusion === null ? null : str(node.conclusion),
        workflowName: workflow === null || workflow === undefined ? "" : str(record(workflow).name),
      };
    }
    if (node.__typename === "StatusContext") return { __typename: "StatusContext", context: str(node.context), state: str(node.state) };
    throw new Error("github_shape");
  });
}

function pullOf(raw: unknown): QaReleaseLanePullRequest {
  const pull = record(raw);
  const number = pull.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) throw new Error("github_shape");
  if (typeof pull.isDraft !== "boolean") throw new Error("github_shape");
  return {
    number,
    createdAt: str(pull.createdAt),
    baseRefName: str(pull.baseRefName),
    headRefName: str(pull.headRefName),
    headRefOid: str(pull.headRefOid).toLowerCase(),
    isDraft: pull.isDraft,
    mergeable: str(pull.mergeable),
    state: str(pull.state),
    statusCheckRollup: rollupOf(pull),
  };
}

export function createQaReleaseGithubPorts(input: {
  http: QaReleaseHttp;
  token: () => Promise<string>;
}): QaReleaseMergeLanePorts["github"] {
  const { http } = input;
  const headers = async (accept = "application/vnd.github+json") => ({
    accept,
    authorization: `Bearer ${await input.token()}`,
    "x-github-api-version": "2022-11-28",
  });
  const get = async (path: string, accept?: string) => {
    const response = await http({ method: "GET", url: `${QA_RELEASE_GITHUB_API}${path}`, headers: await headers(accept) });
    if (response.status !== 200) throw new Error(`github_${response.status}`);
    return response.text;
  };
  const getJson = async (path: string) => parseJson(await get(path));
  const graphql = async (query: string, variables: Record<string, unknown>) => {
    const response = await http({
      method: "POST",
      url: `${QA_RELEASE_GITHUB_API}/graphql`,
      headers: { ...(await headers()), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (response.status !== 200) throw new Error(`github_graphql_${response.status}`);
    const body = record(parseJson(response.text));
    if (body.errors !== undefined) throw new Error("github_graphql_errors");
    return record(record(body.data).repository);
  };
  const repo = { owner: QA_RELEASE_REPOSITORY.owner, name: QA_RELEASE_REPOSITORY.name };

  // The policy documents at develop's tip, read once per round: the inputs the
  // exclusion judges every candidate against (section 8 item 3).
  let policyInputs: Promise<{ tests: string[] | null; own: string[] | null }> | null = null;
  const readPolicyInputs = async () => {
    try {
      const tip = str(record(record(await getJson(`${REPO_PATH}/git/ref/heads/develop`)).object).sha).toLowerCase();
      if (!SHA.test(tip)) throw new Error("github_shape");
      const tree = record(await getJson(`${REPO_PATH}/git/trees/${tip}?recursive=1`));
      if (tree.truncated !== false || !Array.isArray(tree.tree)) return { tests: null, own: null };
      const documents = tree.tree
        .map(record)
        .filter((entry) => entry.type === "blob" && isQaReleasePolicyDocument(str(entry.path)));
      const texts = new Map<string, string>();
      for (const entry of documents) {
        const blob = record(await getJson(`${REPO_PATH}/git/blobs/${str(entry.sha)}`));
        if (blob.encoding !== "base64") throw new Error("github_shape");
        texts.set(str(entry.path), Buffer.from(str(blob.content), "base64").toString("utf8"));
      }
      const policy = texts.get(POLICY_PATH);
      return {
        tests: qaReleasePolicyTestPaths([...texts.values()]),
        own: policy === undefined ? null : qaReleaseAgentOwnPatterns(policy),
      };
    } catch {
      return { tests: null, own: null };
    }
  };

  const changedFilesOf = async (pull: QaReleaseLanePullRequest) => {
    const rest = record(await getJson(`${REPO_PATH}/pulls/${pull.number}`));
    const expected = rest.changed_files;
    const headSha = str(record(rest.head).sha).toLowerCase();
    const files: QaReleaseChangedFile[] = [];
    let complete = false;
    for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
      const batch = await getJson(`${REPO_PATH}/pulls/${pull.number}/files?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error("github_shape");
      for (const raw of batch) {
        const file = record(raw);
        const path = str(file.filename);
        const changed: QaReleaseChangedFile = {
          path,
          previousPath: typeof file.previous_filename === "string" ? file.previous_filename : null,
        };
        if (QA_RELEASE_MIGRATION_SQL_PATH.test(path)) {
          // A deleted migration has no new text to judge; null excludes it --
          // removing an applied migration is never an unattended change.
          changed.migrationSql =
            file.status === "removed"
              ? null
              : await get(`${REPO_PATH}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${pull.headRefOid}`, "application/vnd.github.raw+json").catch(() => null);
        }
        files.push(changed);
      }
      if (batch.length < 100) {
        complete = true;
        break;
      }
    }
    // Complete only when every page was read, the count is the one GitHub
    // states, and the head did not move between the list and this read.
    return {
      files,
      complete: complete && typeof expected === "number" && files.length === expected && headSha === pull.headRefOid,
    };
  };

  const compareStatus = async (from: string, to: string) =>
    str(record(await getJson(`${REPO_PATH}/compare/${from}...${to}?per_page=1`)).status);

  return {
    async listOpenDevelopPulls() {
      const pulls: QaReleaseLanePullRequest[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
        const repository = await graphql(
          `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) {
            pullRequests(states: OPEN, baseRefName: "develop", first: 50, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
              pageInfo { hasNextPage endCursor }
              nodes { ${PULL_FIELDS} }
            } } }`,
          { ...repo, after },
        );
        const connection = record(repository.pullRequests);
        if (!Array.isArray(connection.nodes)) throw new Error("github_shape");
        pulls.push(...connection.nodes.map(pullOf));
        const info = record(connection.pageInfo);
        if (info.hasNextPage === false) return pulls;
        after = str(info.endCursor);
      }
      // More open pull requests than the pages read: the oldest might be
      // missed, so the list is unknown rather than partial.
      throw new Error("github_pulls_unbounded");
    },

    async exclusionInputs(pull): Promise<QaReleaseExclusionInput> {
      policyInputs ??= readPolicyInputs();
      const [inputs, changed] = await Promise.all([policyInputs, changedFilesOf(pull)]);
      return {
        headBranch: pull.headRefName,
        changedFiles: changed.files,
        changedFilesComplete: changed.complete,
        policyTestPaths: inputs.tests,
        agentOwnPatterns: inputs.own,
      };
    },

    async readPull(number): Promise<QaReleasePullRead | null> {
      const repository = await graphql(
        `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
          pullRequest(number: $number) { ${PULL_FIELDS} merged mergeCommit { oid } } } }`,
        { ...repo, number },
      );
      if (repository.pullRequest === null) return null;
      const raw = record(repository.pullRequest);
      if (typeof raw.merged !== "boolean") throw new Error("github_shape");
      const mergeCommit = raw.mergeCommit === null ? null : str(record(raw.mergeCommit).oid).toLowerCase();
      return { ...pullOf(raw), merged: raw.merged, mergeCommitSha: mergeCommit };
    },

    async merge(number, headSha): Promise<QaReleaseMergeCall> {
      if (!SHA.test(headSha)) return { result: "refused" };
      let response: { status: number; text: string };
      try {
        response = await http({
          method: "PUT",
          url: `${QA_RELEASE_GITHUB_API}${REPO_PATH}/pulls/${number}/merge`,
          headers: { ...(await headers()), "content-type": "application/json" },
          body: JSON.stringify({ sha: headSha, merge_method: "merge" }),
        });
      } catch {
        return { result: "unknown" };
      }
      // 405, 409 and 422 are GitHub declining this merge (not mergeable, head
      // moved, a ruleset or validation): not merged. An authentication,
      // permission or rate-limit answer (401, 403, 429) says nothing about the
      // pull request and would walk the queue one refusal per round, so it is
      // unknown, which latches. Anything else -- a 5xx, a timeout, a 200 that
      // does not say merged -- is unknown too.
      if (response.status === 405 || response.status === 409 || response.status === 422) return { result: "refused" };
      if (response.status >= 400 && response.status < 500) return { result: "unknown" };
      if (response.status !== 200) return { result: "unknown" };
      try {
        const body = record(parseJson(response.text));
        const sha = str(body.sha).toLowerCase();
        return body.merged === true && SHA.test(sha) ? { result: "merged", sha } : { result: "unknown" };
      } catch {
        return { result: "unknown" };
      }
    },

    async onDevelop(sha) {
      const status = await compareStatus(sha, "develop");
      if (status === "ahead" || status === "identical") return true;
      if (status === "behind" || status === "diverged") return false;
      return null;
    },

    // Unlike the merge train, a lookup that fails is not left out: the policy
    // (version 4, section 8 item 5) treats an unread list as unreadable, which
    // the round reports and latches on. Leaving a commit out would count a
    // cancelled SKIPPED as a failure, or a replacement as missing, and close
    // the attempt on a guess.
    async commitsContaining(sha, candidates) {
      const containing = new Set<string>();
      for (const candidate of candidates) {
        if (!SHA.test(candidate)) continue;
        const status = await compareStatus(sha, candidate);
        if (status === "ahead" || status === "identical") containing.add(candidate);
        else if (status !== "behind" && status !== "diverged") throw new Error("github_shape");
      }
      return containing;
    },

    async cancelledCommits(commits) {
      const cancelled = new Set<string>();
      for (const commit of commits) {
        if (!SHA.test(commit)) continue;
        const body = record(await getJson(`${REPO_PATH}/commits/${commit}/check-runs?per_page=100`));
        const runs = body.check_runs;
        // More runs than one page holds: the cancelled one may be on the next.
        if (!Array.isArray(runs) || body.total_count !== runs.length) throw new Error("github_check_runs_unread");
        if (runs.some((run) => record(run).conclusion === "cancelled")) cancelled.add(commit);
      }
      return cancelled;
    },
  };
}
