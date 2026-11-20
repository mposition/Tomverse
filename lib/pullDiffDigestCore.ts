/**
 * The digest a pull request's change is bound and approved by.
 *
 * v2 (owner decision 2026-11-18, docs/policy/amux-v22-result-transfer.md §5):
 * the change is its merge base, its head commit and that commit's tree, as
 * git object ids. Every new binding is v2, stored as `v2:` and the hex of
 *
 *   sha256("amux-pull-change-v2\n" + "merge-base " + mergeBaseSha + "\n" +
 *          "head " + headSha + "\n" + "tree " + headTreeSha + "\n")
 *
 * It binds the whole tree, binary files included, at any size: nothing is
 * left to a person because a diff is large or binary. The merge base is read
 * against the base branch as it stands, so develop absorbing part of the
 * branch changes the digest at the same head.
 *
 * v1, kept only to compare records written before v2: sha256 of the diff
 * GitHub serves (`GET /repos/{o}/{r}/pulls/{n}` with
 * `Accept: application/vnd.github.diff`), over the bytes as they came, stored
 * as the bare 64 hex. A stored digest says its own version (pullDigestVersion),
 * and is compared only with a current reading of the same version
 * (pullDigestHolds).
 *
 * Every reader -- the engineering agent's (lib/engineeringAgentGitHubRead.ts),
 * AMUX review's (lib/amux/reviewGitHub.ts), the QA-release merge lane's
 * (lib/qaReleaseMergeLaneGithub.ts) and the publisher's
 * (scripts/engineering-agent-publisher.mjs) -- reads v2 through
 * readPullChangeDigest, so none can disagree on what "the same change" means.
 *
 * Pure and dependency-free beyond node:crypto, so the lane service and the
 * publisher load it with `node --experimental-strip-types`.
 */
import { createHash } from "node:crypto";

/** The largest diff a v1 digest was ever taken of; a larger one never had a v1 binding to compare with. */
export const PULL_DIFF_DIGEST_MAX_BYTES = 1024 * 1024;

const SHA1 = /^[0-9a-f]{40}$/;
const V1 = /^[0-9a-f]{64}$/;
const V2 = /^v2:[0-9a-f]{64}$/;
/** A stored digest of either version, in its stored form. */
export const PULL_DIGEST_PATTERN = /^(v2:)?[0-9a-f]{64}$/;
export const PULL_CHANGE_DIGEST_V2_PREFIX = "v2:";

const sha256Hex = (bytes: Uint8Array | string) =>
  createHash("sha256").update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes).digest("hex");

/** v1, for records written before v2 only: sha256 hex of a diff's bytes; text is taken as its UTF-8 bytes. */
export const pullDiffDigest = (diff: Uint8Array | string): string => sha256Hex(diff);

export type PullChange = { mergeBaseSha: string; headSha: string; headTreeSha: string };

/** v2, in its stored form. Each id must be a lowercase 40 hex git object id. */
export function pullChangeDigest(change: PullChange): string {
  const { mergeBaseSha, headSha, headTreeSha } = change;
  for (const id of [mergeBaseSha, headSha, headTreeSha]) {
    if (typeof id !== "string" || !SHA1.test(id)) throw new Error("pull_change_id_invalid");
  }
  return PULL_CHANGE_DIGEST_V2_PREFIX + sha256Hex(
    `amux-pull-change-v2\nmerge-base ${mergeBaseSha}\nhead ${headSha}\ntree ${headTreeSha}\n`);
}

/** Which version a stored digest is, or null when it is neither. */
export const pullDigestVersion = (stored: unknown): 1 | 2 | null =>
  typeof stored !== "string" ? null : V2.test(stored) ? 2 : V1.test(stored) ? 1 : null;

/** What a reader read now: the v2 change digest, and the v1 diff digest only where a v1 record needs it. */
export type PullDigestReading = { changeDigest?: string | null; diffDigest?: string | null };

/**
 * The current digest in the stored digest's own version, or null when that
 * version could not be read now (or the stored value is neither version).
 */
export function pullDigestCurrent(stored: unknown, current: PullDigestReading): string | null {
  const version = pullDigestVersion(stored);
  const value = version === 2 ? current.changeDigest : version === 1 ? current.diffDigest : null;
  return typeof value === "string" && pullDigestVersion(value) === version ? value : null;
}

/** Whether a stored digest still holds: v1 against v1, v2 against v2, never across. */
export const pullDigestHolds = (stored: unknown, current: PullDigestReading): boolean =>
  pullDigestCurrent(stored, current) === stored;

/** A JSON GET of a path under `/repos/{owner}/{repo}`, as the caller authenticates and bounds it. */
export type PullChangeJsonRead = (path: string) => Promise<unknown>;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const lowerSha = (value: unknown): string | null =>
  typeof value === "string" && SHA1.test(value.toLowerCase()) ? value.toLowerCase() : null;
/** A branch name the compare path takes as it is: no slash, no revision syntax. */
const PLAIN_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/**
 * The v2 digest of `base...headSha` as GitHub has it now: the merge base from
 * the compare API, the head commit's tree from the git commits API. `base` is
 * the pull request's base branch (an open pull request) or a commit (a merged
 * one, readMergedPullChangeDigest). Throws `pull_change_unreadable` on anything
 * not of the expected shape; the caller reads that as not read now.
 */
export async function readPullChangeDigest(getJson: PullChangeJsonRead,
  input: { base: string; headSha: string }): Promise<PullChange & { digest: string }> {
  const headSha = lowerSha(input.headSha);
  const base = lowerSha(input.base) ?? (PLAIN_REF.test(input.base) && !input.base.includes("..") ? input.base : null);
  if (headSha === null || base === null) throw new Error("pull_change_unreadable");
  // per_page=1 keeps the commit list short; GitHub lists the changed files
  // (up to 300) on this first page whatever it is asked.
  const comparison = record(await getJson(`/compare/${base}...${headSha}?per_page=1&page=1`));
  const mergeBaseSha = lowerSha(record(comparison?.merge_base_commit)?.sha);
  const commit = record(await getJson(`/git/commits/${headSha}`));
  const headTreeSha = lowerSha(record(commit?.tree)?.sha);
  if (mergeBaseSha === null || headTreeSha === null || lowerSha(commit?.sha) !== headSha ||
      !["ahead", "behind", "diverged", "identical"].includes(String(comparison?.status))) {
    throw new Error("pull_change_unreadable");
  }
  const change = { mergeBaseSha, headSha, headTreeSha };
  return { ...change, digest: pullChangeDigest(change) };
}

/**
 * A merged pull request's v2 digest: its base branch now contains the head,
 * so the merge base is read against the merge commit's first parent. For a
 * merge commit or a squash that is the base branch just before the merge; for
 * a rebase it is a rewritten commit, none of which the head contains, so the
 * merge base is the same.
 */
export async function readMergedPullChangeDigest(getJson: PullChangeJsonRead,
  input: { mergeCommitSha: string; headSha: string }): Promise<PullChange & { digest: string }> {
  const mergeCommitSha = lowerSha(input.mergeCommitSha);
  if (mergeCommitSha === null) throw new Error("pull_change_unreadable");
  const merge = record(await getJson(`/git/commits/${mergeCommitSha}`));
  const parents = Array.isArray(merge?.parents) ? merge.parents : null;
  const parent = lowerSha(record(parents?.[0])?.sha);
  if (lowerSha(merge?.sha) !== mergeCommitSha || parent === null) throw new Error("pull_change_unreadable");
  return readPullChangeDigest(getJson, { base: parent, headSha: input.headSha });
}
