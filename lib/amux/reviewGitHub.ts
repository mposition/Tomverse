import "server-only";

import { createHash } from "node:crypto";

/** One fixed repository. A caller can supply a PR number, never an API URL. */
const REPOSITORY = "mposition/Tomverse";
const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const TIMEOUT_MS = 8_000;
const MAX_PR_JSON_BYTES = 256 * 1024;
export const AMUX_REVIEW_MAX_DIFF_BYTES = 1024 * 1024;
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
    | "binary_diff"
    | "unsafe_display",
  ) {
    // Never put upstream response text, URLs, credentials or diff text in errors.
    super(code);
    this.name = "AmuxReviewGitHubError";
  }
}

export type AmuxReviewPullRequest = {
  prNumber: number;
  baseSha: string;
  headSha: string;
  diffDigest: string;
  /** Ephemeral review text. Callers must not persist, log or cache it. */
  diffText: string;
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
  number: number,
  accept: "application/vnd.github+json" | "application/vnd.github.diff",
  token: string,
  fetchImpl: FetchLike,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_ORIGIN}/repos/${REPOSITORY}/pulls/${number}`, {
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
  if (!response.ok) throw new AmuxReviewGitHubError("http_error");
  return response;
}

async function githubPrSnapshot(number: number, token: string, fetchImpl: FetchLike) {
  const response = await githubGet(number, "application/vnd.github+json", token, fetchImpl);
  const bytes = await readBounded(response, MAX_PR_JSON_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof AmuxReviewGitHubError) throw error;
    throw new AmuxReviewGitHubError("invalid_response");
  }
  return parseSnapshot(value, number);
}

/**
 * Read only an open, same-repository PR targeting develop. The second PR read
 * rejects a head/base/state change during diff retrieval; the decision path
 * must bind the base SHA, head SHA and diff digest, then re-check them before
 * approving it.
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
    const diffResponse = await githubGet(prNumber, "application/vnd.github.diff", token, fetchImpl);
    if (diffResponse.headers.get("content-type")?.includes("json")) {
      await diffResponse.body?.cancel();
      throw new AmuxReviewGitHubError("invalid_response");
    }
    const diffBytes = await readBounded(diffResponse, AMUX_REVIEW_MAX_DIFF_BYTES);
    const diffText = decodeUtf8(diffBytes);
    // The operator must see the exact bytes whose digest is approved. Reject
    // controls that can visually reorder or hide the diff instead of silently
    // normalising the displayed content away from its authoritative digest.
    if (/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(diffText)) {
      throw new AmuxReviewGitHubError("unsafe_display");
    }
    if (!diffText.startsWith("diff --git ") ||
        /^GIT binary patch$/m.test(diffText) ||
        /^Binary files .+ differ$/m.test(diffText)) {
      throw new AmuxReviewGitHubError("binary_diff");
    }
    const diffDigest = createHash("sha256").update(diffBytes).digest("hex");
    const after = await githubPrSnapshot(prNumber, token, fetchImpl);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new AmuxReviewGitHubError("pr_changed");
    }
    return {
      prNumber,
      baseSha: before.baseSha,
      headSha: before.headSha,
      diffDigest,
      diffText,
      htmlUrl: `https://github.com/${REPOSITORY}/pull/${prNumber}`,
    };
  } catch (error) {
    if (error instanceof AmuxReviewGitHubError) throw error;
    throw new AmuxReviewGitHubError("transport_error");
  }
}
