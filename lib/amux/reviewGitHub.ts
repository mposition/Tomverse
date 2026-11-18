import "server-only";

import { AMUX_V22_FILE_MAX_BYTES } from "@/lib/amux/v22PatchLimit";
import { PULL_DIFF_DIGEST_MAX_BYTES, pullDiffDigest, readPullChangeDigest } from "@/lib/pullDiffDigestCore";

/** One fixed repository. A caller can supply a PR number, never an API URL. */
const REPOSITORY = "mposition/Tomverse";
const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const TIMEOUT_MS = 8_000;
const MAX_PR_JSON_BYTES = 256 * 1024;
/**
 * The compare answer lists the changed files with their patches; it is read
 * up to GitHub's own file limit, as the engineering agent's read does.
 */
const MAX_COMPARE_JSON_BYTES = AMUX_V22_FILE_MAX_BYTES;
/**
 * The largest diff shown on the review screen. A larger one is reviewed on
 * GitHub: the approval binds the change digest, not the shown text, so its
 * size no longer stops an approval (owner decision 2026-11-18).
 */
export const AMUX_REVIEW_MAX_DIFF_BYTES = PULL_DIFF_DIGEST_MAX_BYTES;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

type FetchLike = typeof fetch;

export class AmuxReviewGitHubError extends Error {
  constructor(readonly code:
    | "invalid_pr_number"
    | "not_configured"
    | "transport_error"
    | "http_error"
    | "invalid_response"
    | "wrong_pr"
    | "pr_changed"
    | "oversized_response"
    | "binary_diff",
  ) {
    // Never put upstream response text, URLs, credentials or diff text in errors.
    super(code);
    this.name = "AmuxReviewGitHubError";
  }
}

/** Why the diff is not shown on the review screen: the pull request is then reviewed on GitHub. */
export type AmuxReviewDiffHidden = "oversized" | "binary" | "unsafe_display";

export type AmuxReviewPullRequest = {
  prNumber: number;
  baseSha: string;
  headSha: string;
  /** The v2 change digest an approval binds (lib/pullDiffDigestCore.ts): merge base, head and tree. */
  changeDigest: string;
  /** The v1 digest of the diff shown, for a proposal prepared before v2; null when no diff is shown. */
  diffDigest: string | null;
  /** Ephemeral review text, or null when it is not shown here. Callers must not persist, log or cache it. */
  diffText: string | null;
  diffHidden: AmuxReviewDiffHidden | null;
  htmlUrl: string;
};

type PullRequestSnapshot = {
  number: number;
  state: "open";
  merged: false;
  baseRepo: typeof REPOSITORY;
  baseRef: "develop";
  baseSha: string;
  headRepo: typeof REPOSITORY;
  headSha: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseSnapshot(value: unknown, requestedNumber: number): PullRequestSnapshot {
  const pr = record(value);
  const base = record(pr?.base);
  const head = record(pr?.head);
  const baseRepo = record(base?.repo);
  const headRepo = record(head?.repo);
  if (!pr || !base || !head || !baseRepo || !headRepo ||
      pr.number !== requestedNumber || pr.state !== "open" || pr.merged !== false ||
      baseRepo.full_name !== REPOSITORY || headRepo.full_name !== REPOSITORY ||
      base.ref !== "develop" || typeof base.sha !== "string" ||
      !SHA_PATTERN.test(base.sha) || typeof head.sha !== "string" ||
      !SHA_PATTERN.test(head.sha)) {
    throw new AmuxReviewGitHubError("wrong_pr");
  }
  return {
    number: requestedNumber,
    state: "open",
    merged: false,
    baseRepo: REPOSITORY,
    baseRef: "develop",
    baseSha: base.sha.toLowerCase(),
    headRepo: REPOSITORY,
    headSha: head.sha.toLowerCase(),
  };
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const claimedLength = response.headers.get("content-length");
  if (claimedLength !== null && /^\d+$/.test(claimedLength) && Number(claimedLength) > limit) {
    await response.body?.cancel();
    throw new AmuxReviewGitHubError("oversized_response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AmuxReviewGitHubError("invalid_response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new AmuxReviewGitHubError("oversized_response");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new AmuxReviewGitHubError("binary_diff");
    return text;
  } catch (error) {
    if (error instanceof AmuxReviewGitHubError) throw error;
    throw new AmuxReviewGitHubError("binary_diff");
  }
}

async function githubGet(
  path: string,
  accept: "application/vnd.github+json" | "application/vnd.github.diff",
  token: string,
  fetchImpl: FetchLike,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_ORIGIN}/repos/${REPOSITORY}${path}`, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
    });
  } catch {
    throw new AmuxReviewGitHubError("transport_error");
  }
  // GitHub answers 406 for a diff too large to render: the diff is then not shown.
  if (!response.ok && !(accept === "application/vnd.github.diff" && response.status === 406)) {
    await response.body?.cancel().catch(() => undefined);
    throw new AmuxReviewGitHubError("http_error");
  }
  return response;
}

async function githubJson(path: string, limit: number, token: string, fetchImpl: FetchLike): Promise<unknown> {
  const response = await githubGet(path, "application/vnd.github+json", token, fetchImpl);
  const bytes = await readBounded(response, limit);
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof AmuxReviewGitHubError) throw error;
    throw new AmuxReviewGitHubError("invalid_response");
  }
}

async function githubPrSnapshot(number: number, token: string, fetchImpl: FetchLike) {
  return parseSnapshot(await githubJson(`/pulls/${number}`, MAX_PR_JSON_BYTES, token, fetchImpl), number);
}

/**
 * The diff for the review screen, when it can be shown exactly: the operator
 * must see the exact bytes, so text with controls that can visually reorder
 * or hide the diff is not shown rather than normalised, and a binary or
 * oversized diff is not shown either. Not shown, it is reviewed on GitHub;
 * the approval binds the change digest either way.
 */
async function readShownDiff(number: number, token: string, fetchImpl: FetchLike): Promise<
  { diffText: string; diffDigest: string; diffHidden: null } |
  { diffText: null; diffDigest: null; diffHidden: AmuxReviewDiffHidden }> {
  const hidden = (diffHidden: AmuxReviewDiffHidden) => ({ diffText: null, diffDigest: null, diffHidden });
  const response = await githubGet(`/pulls/${number}`, "application/vnd.github.diff", token, fetchImpl);
  if (response.status === 406) {
    await response.body?.cancel().catch(() => undefined);
    return hidden("oversized");
  }
  if (response.headers.get("content-type")?.includes("json")) {
    await response.body?.cancel();
    throw new AmuxReviewGitHubError("invalid_response");
  }
  let bytes: Uint8Array;
  let text: string;
  try {
    bytes = await readBounded(response, AMUX_REVIEW_MAX_DIFF_BYTES);
    text = decodeUtf8(bytes);
  } catch (error) {
    if (!(error instanceof AmuxReviewGitHubError)) throw error;
    if (error.code === "oversized_response") return hidden("oversized");
    if (error.code === "binary_diff") return hidden("binary");
    throw error;
  }
  if (/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(text)) {
    return hidden("unsafe_display");
  }
  if (!text.startsWith("diff --git ") || /^GIT binary patch$/m.test(text) || /^Binary files .+ differ$/m.test(text)) {
    return hidden("binary");
  }
  return { diffText: text, diffDigest: pullDiffDigest(bytes), diffHidden: null };
}

/**
 * Read only an open, same-repository PR targeting develop. The second PR read
 * rejects a head/base/state change during the reads; the decision path must
 * bind the base SHA, head SHA and change digest (v2, lib/pullDiffDigestCore.ts),
 * then re-check them before approving it. A diff too large, binary or unsafe
 * to show is not shown, and no longer stops an approval (owner decision
 * 2026-11-18): the person reviews it on GitHub.
 *
 * Configure AMUX_REVIEW_GITHUB_READ_TOKEN as a fine-grained token installed on
 * mposition/Tomverse only, with Metadata plus Pull requests/Contents read and
 * no write permissions. This module never reuses an execution/publisher token.
 */
export async function readAmuxReviewPullRequest(
  prNumber: number,
  fetchImpl: FetchLike = fetch,
): Promise<AmuxReviewPullRequest> {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new AmuxReviewGitHubError("invalid_pr_number");
  }
  const token = process.env.AMUX_REVIEW_GITHUB_READ_TOKEN?.trim();
  if (!token) throw new AmuxReviewGitHubError("not_configured");

  try {
    const before = await githubPrSnapshot(prNumber, token, fetchImpl);
    let change: Awaited<ReturnType<typeof readPullChangeDigest>>;
    try {
      change = await readPullChangeDigest(
        (path) => githubJson(path, MAX_COMPARE_JSON_BYTES, token, fetchImpl),
        { base: before.baseRef, headSha: before.headSha });
    } catch (error) {
      if (error instanceof AmuxReviewGitHubError) throw error;
      throw new AmuxReviewGitHubError("invalid_response");
    }
    const shown = await readShownDiff(prNumber, token, fetchImpl);
    const after = await githubPrSnapshot(prNumber, token, fetchImpl);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new AmuxReviewGitHubError("pr_changed");
    }
    return {
      prNumber,
      baseSha: before.baseSha,
      headSha: before.headSha,
      changeDigest: change.digest,
      ...shown,
      htmlUrl: `https://github.com/${REPOSITORY}/pull/${prNumber}`,
    };
  } catch (error) {
    if (error instanceof AmuxReviewGitHubError) throw error;
    throw new AmuxReviewGitHubError("transport_error");
  }
}
