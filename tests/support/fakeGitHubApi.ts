/**
 * A tiny in-memory GitHub REST API for the promotion contract tests: pull
 * requests, their files, compare, and file contents at a commit. It answers
 * only the GETs lib/feedbackAutoFixGitHub.ts makes, and records every request
 * so a test can assert that nothing but reads happened.
 */

export type FakePullRequest = {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  mergeCommitSha: string | null;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  headRepository?: string;
  baseRepository?: string;
  files: string[];
};

export type FakeGitHub = {
  repository: string;
  pulls: FakePullRequest[];
  /** blobs[commitSha][path] = blob sha; absent = no file at that commit. */
  blobs: Record<string, Record<string, string>>;
  /** compare[`${base}...${head}`] = merge base; missing = base itself. */
  mergeBases: Record<string, string>;
  requests: Array<{ method: string; url: string; authorization: string | null }>;
};

export const createFakeGitHub = (repository = "mposition/Tomverse"): FakeGitHub => ({
  repository,
  pulls: [],
  blobs: {},
  mergeBases: {},
  requests: [],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const pullJson = (github: FakeGitHub, pr: FakePullRequest) => ({
  number: pr.number,
  html_url: `https://github.com/${github.repository}/pull/${pr.number}`,
  state: pr.state,
  merged: pr.merged,
  merged_at: pr.merged ? "2026-09-15T12:00:00Z" : null,
  merge_commit_sha: pr.mergeCommitSha,
  merged_by: pr.merged ? { login: "mposition" } : null,
  base: {
    ref: pr.baseRef,
    sha: pr.baseSha,
    repo: { full_name: pr.baseRepository ?? github.repository },
  },
  head: {
    ref: pr.headRef,
    sha: pr.headSha,
    repo: { full_name: pr.headRepository ?? github.repository },
  },
});

/** A fetch implementation serving `github`; anything else is a 599. */
export const fakeGitHubFetch =
  (github: FakeGitHub, fallback?: typeof fetch): typeof fetch =>
  async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "api.github.com") {
      if (fallback) return fallback(input, init);
      return new Response("unexpected host", { status: 599 });
    }
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    github.requests.push({
      method,
      url: url.pathname + url.search,
      authorization: headers.get("authorization"),
    });
    if (method !== "GET") return new Response("read only", { status: 405 });
    const prefix = `/repos/${github.repository}`;
    if (!url.pathname.startsWith(prefix)) return json({ message: "Not Found" }, 404);
    const path = url.pathname.slice(prefix.length);

    let match = /^\/pulls\/(\d+)\/files$/.exec(path);
    if (match) {
      const pr = github.pulls.find((item) => item.number === Number(match![1]));
      return pr ? json(pr.files.map((filename) => ({ filename }))) : json({}, 404);
    }
    match = /^\/pulls\/(\d+)$/.exec(path);
    if (match) {
      const pr = github.pulls.find((item) => item.number === Number(match![1]));
      return pr ? json(pullJson(github, pr)) : json({ message: "Not Found" }, 404);
    }
    if (path === "/pulls") {
      const head = url.searchParams.get("head") ?? "";
      const base = url.searchParams.get("base");
      const [owner, branch] = head.split(":");
      return json(
        github.pulls
          .filter(
            (pr) =>
              pr.headRef === branch &&
              (!base || pr.baseRef === base) &&
              (pr.headRepository ?? github.repository).split("/")[0] === owner
          )
          .map((pr) => pullJson(github, pr))
      );
    }
    match = /^\/compare\/(.+)\.\.\.(.+)$/.exec(path);
    if (match) {
      const base = decodeURIComponent(match[1]);
      const head = decodeURIComponent(match[2]);
      const mergeBase = github.mergeBases[`${base}...${head}`] ?? base;
      return json({
        merge_base_commit: { sha: mergeBase },
        status: mergeBase === base ? "ahead" : "diverged",
      });
    }
    match = /^\/contents\/(.+)$/.exec(path);
    if (match) {
      const filePath = match[1].split("/").map(decodeURIComponent).join("/");
      const ref = url.searchParams.get("ref") ?? "";
      const sha = github.blobs[ref]?.[filePath];
      return sha ? json({ type: "file", sha, path: filePath }) : json({ message: "Not Found" }, 404);
    }
    return json({ message: "Not Found" }, 404);
  };
