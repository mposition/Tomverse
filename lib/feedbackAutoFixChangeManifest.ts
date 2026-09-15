import { createHash } from "node:crypto";

/**
 * The identity of an approved change, and the rule for carrying it to main.
 *
 * An owner approves one develop PR at one head. The fix then reaches main
 * through a separate promotion PR that cherry-picks the develop merge commit,
 * so the two PRs are different commits and no SHA can say "this is still what
 * was approved". A line-level digest cannot either: the same added and
 * removed lines applied at a different place in a file are a different
 * change (independent review, round 1 N1).
 *
 * So the identity is a manifest of whole files: for every path the approved
 * PR touches, the git blob before the change (at the PR's merge base) and the
 * blob after it (at the approved head), with `null` for "absent". Two rules
 * follow, and both fail closed:
 *
 *  - main may receive the change only if every one of those paths on main is
 *    byte-for-byte the approved *before* blob -- otherwise the surrounding
 *    code differs and the approval did not cover the result;
 *  - the promotion PR is the approved change only if it touches exactly those
 *    paths and every one ends at the approved *after* blob.
 *
 * Together they mean the file contents production runs for these paths are
 * the contents the owner looked at. Renames are two entries (a deletion and an
 * addition), which is how `git diff --no-renames` and a manifest built from
 * the GitHub API both see them.
 *
 * Pure. The server builds manifests from the GitHub API, the promotion
 * workflow from `git`; both call the checks below.
 * docs/policy/trace-feedback-automation.md §9.3.
 */

export type ChangeManifestEntry = {
  path: string;
  /** Blob SHA before the change, or null when the file did not exist. */
  baseBlob: string | null;
  /** Blob SHA after the change, or null when the change deletes the file. */
  headBlob: string | null;
};

export const CHANGE_MANIFEST_VERSION = "fcm1";

const BLOB_SHA = /^[0-9a-f]{40}$/;

const normaliseBlob = (value: string | null) =>
  value === null ? null : value.toLowerCase();

/** Structural problems that make a manifest unusable, empty when valid. */
export const changeManifestProblems = (
  entries: readonly ChangeManifestEntry[]
): string[] => {
  const problems: string[] = [];
  if (entries.length === 0) problems.push("empty manifest");
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.path || entry.path.startsWith("/") || entry.path.includes("\0")) {
      problems.push(`invalid path: ${JSON.stringify(entry.path)}`);
    }
    if (seen.has(entry.path)) problems.push(`duplicate path: ${entry.path}`);
    seen.add(entry.path);
    for (const blob of [entry.baseBlob, entry.headBlob]) {
      if (blob !== null && !BLOB_SHA.test(blob.toLowerCase())) {
        problems.push(`invalid blob for ${entry.path}`);
      }
    }
    if (entry.baseBlob === null && entry.headBlob === null) {
      problems.push(`no-op entry for ${entry.path}`);
    }
    if (
      entry.baseBlob !== null &&
      entry.headBlob !== null &&
      entry.baseBlob.toLowerCase() === entry.headBlob.toLowerCase()
    ) {
      problems.push(`unchanged entry for ${entry.path}`);
    }
  }
  return problems;
};

/** Canonical order and case, so equal manifests compare and digest equal. */
export const canonicalChangeManifest = (
  entries: readonly ChangeManifestEntry[]
): ChangeManifestEntry[] =>
  [...entries]
    .map((entry) => ({
      path: entry.path,
      baseBlob: normaliseBlob(entry.baseBlob),
      headBlob: normaliseBlob(entry.headBlob),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** Digest of a valid manifest, or null for an invalid one. */
export const changeManifestDigest = (
  entries: readonly ChangeManifestEntry[]
): string | null => {
  if (changeManifestProblems(entries).length > 0) return null;
  const hash = createHash("sha256");
  hash.update(`${CHANGE_MANIFEST_VERSION}\n`);
  for (const entry of canonicalChangeManifest(entries)) {
    hash.update(
      `${entry.path.length}:${entry.path} ${entry.baseBlob ?? "-"} ${entry.headBlob ?? "-"}\n`
    );
  }
  return `${CHANGE_MANIFEST_VERSION}:${hash.digest("hex")}`;
};

/**
 * May main receive this change? `mainBlobs` maps each approved path to its
 * blob on main (null = absent). Anything missing from the map is a refusal.
 */
export const mainAcceptsApprovedChange = (
  approved: readonly ChangeManifestEntry[],
  mainBlobs: ReadonlyMap<string, string | null>
): { ok: true } | { ok: false; reason: string } => {
  if (changeManifestProblems(approved).length > 0) {
    return { ok: false, reason: "approved manifest invalid" };
  }
  for (const entry of canonicalChangeManifest(approved)) {
    if (!mainBlobs.has(entry.path)) {
      return { ok: false, reason: `main blob unknown for ${entry.path}` };
    }
    const onMain = normaliseBlob(mainBlobs.get(entry.path) ?? null);
    if (onMain !== entry.baseBlob) {
      return {
        ok: false,
        reason: `main differs from the approved base at ${entry.path}`,
      };
    }
  }
  return { ok: true };
};

/**
 * Is `candidate` (the promotion PR's own manifest, against main) exactly the
 * approved change? Same paths, same before blobs, same after blobs.
 */
export const isApprovedChange = (
  approved: readonly ChangeManifestEntry[],
  candidate: readonly ChangeManifestEntry[]
): { ok: true } | { ok: false; reason: string } => {
  const approvedDigest = changeManifestDigest(approved);
  if (!approvedDigest) return { ok: false, reason: "approved manifest invalid" };
  const candidateDigest = changeManifestDigest(candidate);
  if (!candidateDigest) return { ok: false, reason: "candidate manifest invalid" };
  if (approvedDigest !== candidateDigest) {
    const approvedPaths = canonicalChangeManifest(approved).map((e) => e.path);
    const candidatePaths = canonicalChangeManifest(candidate).map((e) => e.path);
    return {
      ok: false,
      reason:
        approvedPaths.join("\n") === candidatePaths.join("\n")
          ? "file contents differ from the approved change"
          : "the set of changed files differs from the approved change",
    };
  }
  return { ok: true };
};

/** Parses a stored manifest (JSON column) without trusting its shape. */
export const parseStoredChangeManifest = (
  value: unknown
): ChangeManifestEntry[] | null => {
  if (!Array.isArray(value)) return null;
  const entries: ChangeManifestEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { path, baseBlob, headBlob } = item as Record<string, unknown>;
    if (typeof path !== "string") return null;
    if (baseBlob !== null && typeof baseBlob !== "string") return null;
    if (headBlob !== null && typeof headBlob !== "string") return null;
    entries.push({ path, baseBlob, headBlob });
  }
  return changeManifestProblems(entries).length === 0 ? entries : null;
};
