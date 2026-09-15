import "server-only";

import type { ChangeManifestEntry } from "@/lib/feedbackAutoFixChangeManifest";

/**
 * Read-only GitHub access for owner-approved promotion.
 *
 * Every GitHub fact the promotion depends on -- a PR's repository, base, head,
 * merge state and merge commit, and the blobs of the files it changes -- is
 * read here by the server itself. No workflow's report of those facts is ever
 * taken as true (independent review, round 0 F3).
 *
 * The credential is a fine-grained token scoped to this one repository with
 * read-only Contents, Pull requests and Metadata, and nothing else: this
 * module performs GETs only. It cannot merge, push, comment or dispatch.
 * Leaking it exposes the private source, which is why it has an expiry and a
 * rotation runbook (docs/policy/trace-feedback-automation.md §9.3).
 */

const GITHUB_API = "https://api.github.com";
const GITHUB_TIMEOUT_MS = 8_000;
/** A PR's files are read in one page; the change policy allows at most 5. */
const MAX_PR_FILES = 100;

type FetchLike = typeof fetch;

export class GitHubReadError extends Error {
  constructor(
    readonly code:
      | "not_configured"
      | "http_error"
      | "unexpected_shape"
      | "too_many_files",
    message: string
  ) {
    super(message);
    this.name = "GitHubReadError";
  }
}

export const DEFAULT_AUTOFIX_GITHUB_REPOSITORY = "mposition/Tomverse";

/** owner/name of the one repository promotion may ever read. */
export const autoFixGitHubRepository = () =>
  process.env.FEEDBACK_AUTOFIX_GITHUB_REPOSITORY?.trim() ||
  DEFAULT_AUTOFIX_GITHUB_REPOSITORY;

const readToken = () => process.env.FEEDBACK_AUTOFIX_GITHUB_READ_TOKEN?.trim() || "";

export const isAutoFixGitHubReadConfigured = () => readToken().length > 0;

const get = async (
  path: string,
  fetchImpl: FetchLike,
  { allowNotFound = false }: { allowNotFound?: boolean } = {}
): Promise<unknown | null> => {
  const token = readToken();
  if (!token) {
    throw new GitHubReadError("not_configured", "GitHub read token is not set.");
  }
  const response = await fetchImpl(`${GITHUB_API}${path}`, {
    method: "GET",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    // Status only: a response body can echo request details.
    throw new GitHubReadError("http_error", `GitHub responded ${response.status}.`);
  }
  return response.json();
};

const str = (value: unknown) => (typeof value === "string" ? value : null);
const record = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

export type PullRequestFacts = {
  number: number;
  htmlUrl: string | null;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergedBy: string | null;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  /** owner/name of the repository the head branch lives in. */
  headRepository: string | null;
  baseRepository: string | null;
};

const repoPath = () => `/repos/${autoFixGitHubRepository()}`;

const parsePullRequest = (value: unknown): PullRequestFacts => {
  const pr = record(value);
  const base = record(pr?.base);
  const head = record(pr?.head);
  const number = pr?.number;
  const state = pr?.state;
  if (
    !pr ||
    !base ||
    !head ||
    typeof number !== "number" ||
    (state !== "open" && state !== "closed") ||
    !str(base.ref) ||
    !str(base.sha) ||
    !str(head.ref) ||
    !str(head.sha)
  ) {
    throw new GitHubReadError("unexpected_shape", "Unexpected pull request shape.");
  }
  return {
    number,
    htmlUrl: str(pr.html_url),
    state,
    merged: pr.merged === true,
    mergedAt: str(pr.merged_at),
    mergeCommitSha: str(pr.merge_commit_sha)?.toLowerCase() ?? null,
    mergedBy: str(record(pr.merged_by)?.login),
    baseRef: base.ref as string,
    baseSha: (base.sha as string).toLowerCase(),
    headRef: head.ref as string,
    headSha: (head.sha as string).toLowerCase(),
    headRepository: str(record(head.repo)?.full_name),
    baseRepository: str(record(base.repo)?.full_name),
  };
};

export const getPullRequest = async (
  number: number,
  fetchImpl: FetchLike = fetch
): Promise<PullRequestFacts | null> => {
  if (!Number.isInteger(number) || number <= 0) return null;
  const value = await get(`${repoPath()}/pulls/${number}`, fetchImpl, {
    allowNotFound: true,
  });
  return value === null ? null : parsePullRequest(value);
};

/**
 * The PRs whose head is `branch` in this repository and whose base is `base`,
 * newest first, any state. Head is qualified with the repository owner, so a
 * fork's branch of the same name is never returned.
 */
export const findPullRequestsByHead = async (
  branch: string,
  base: string,
  fetchImpl: FetchLike = fetch
): Promise<PullRequestFacts[]> => {
  const owner = autoFixGitHubRepository().split("/")[0];
  const query = new URLSearchParams({
    head: `${owner}:${branch}`,
    base,
    state: "all",
    per_page: "10",
  });
  const value = await get(`${repoPath()}/pulls?${query}`, fetchImpl);
  if (!Array.isArray(value)) {
    throw new GitHubReadError("unexpected_shape", "Unexpected pull request list.");
  }
  return value.map(parsePullRequest);
};

const encodePath = (path: string) =>
  path.split("/").map((segment) => encodeURIComponent(segment)).join("/");

/** The blob SHA of `path` at `ref`, or null when no file exists there. */
export const getBlobAt = async (
  ref: string,
  path: string,
  fetchImpl: FetchLike = fetch
): Promise<string | null> => {
  const value = await get(
    `${repoPath()}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    fetchImpl,
    { allowNotFound: true }
  );
  if (value === null) return null;
  const item = record(value);
  if (!item || Array.isArray(value)) {
    // A directory listing: not a file, so no blob -- and not a change the
    // policy allows. Refused rather than treated as absent.
    throw new GitHubReadError("unexpected_shape", "Path is not a single file.");
  }
  const sha = str(item.sha);
  if (item.type !== "file" || !sha) {
    throw new GitHubReadError("unexpected_shape", "Path is not a regular file.");
  }
  return sha.toLowerCase();
};

/** The merge base of two commits and whether `base` is an ancestor of `head`. */
export const compareCommits = async (
  base: string,
  head: string,
  fetchImpl: FetchLike = fetch
): Promise<{ mergeBaseSha: string; baseIsAncestor: boolean }> => {
  const value = record(
    await get(
      `${repoPath()}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
      fetchImpl
    )
  );
  const mergeBase = str(record(value?.merge_base_commit)?.sha);
  const status = str(value?.status);
  if (!mergeBase || !status) {
    throw new GitHubReadError("unexpected_shape", "Unexpected compare shape.");
  }
  return {
    mergeBaseSha: mergeBase.toLowerCase(),
    baseIsAncestor: status === "ahead" || status === "identical",
  };
};

/**
 * The change manifest of a PR at its current head: for every path it touches,
 * the blob at the merge base with its base branch and the blob at the head.
 * Blobs are read from the contents API at both commits rather than taken
 * from the files listing, so a rename or deletion is described by what is
 * actually at each commit.
 */
export const buildPullRequestManifest = async (
  pr: PullRequestFacts,
  fetchImpl: FetchLike = fetch
): Promise<{ mergeBaseSha: string; entries: ChangeManifestEntry[] }> => {
  const files = await get(
    `${repoPath()}/pulls/${pr.number}/files?per_page=${MAX_PR_FILES}`,
    fetchImpl
  );
  if (!Array.isArray(files)) {
    throw new GitHubReadError("unexpected_shape", "Unexpected PR files list.");
  }
  if (files.length >= MAX_PR_FILES) {
    throw new GitHubReadError("too_many_files", "PR changes too many files.");
  }
  const paths = new Set<string>();
  for (const item of files) {
    const file = record(item);
    const filename = str(file?.filename);
    if (!filename) {
      throw new GitHubReadError("unexpected_shape", "Unexpected PR file entry.");
    }
    paths.add(filename);
    const previous = str(file?.previous_filename);
    if (previous) paths.add(previous);
  }
  const { mergeBaseSha } = await compareCommits(pr.baseSha, pr.headSha, fetchImpl);
  const entries: ChangeManifestEntry[] = [];
  for (const path of [...paths].sort()) {
    entries.push({
      path,
      baseBlob: await getBlobAt(mergeBaseSha, path, fetchImpl),
      headBlob: await getBlobAt(pr.headSha, path, fetchImpl),
    });
  }
  return { mergeBaseSha, entries };
};
