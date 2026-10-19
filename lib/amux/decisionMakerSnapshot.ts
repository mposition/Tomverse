import { createHash } from "node:crypto";

import { dmSnapshotManifestDigest } from "./decisionMakerBodyCore.ts";
import {
  encodeRepositoryPath,
  isFetchableTreeMode,
  isSecretRepositoryPath,
  isSnapshotTargetSha,
  repositoryPathRefusal,
} from "./decisionMakerCore.ts";
import { detectSecretsInFields } from "../engineeringAgentSecretPatterns.ts";

/**
 * The AMUX Decision Maker's repository snapshot, stage S2b
 * (docs/policy/amux-decision-maker.md §5, "저장소 스냅샷 — 공개된 내용만").
 *
 * The broker builds it, holding no credential: one public commit lookup, one
 * recursive tree, and one public raw read per file, from an HTTPS client with
 * an empty environment -- no `gh`, `git`, netrc, credential helper or token,
 * and no authenticated retry. The bytes go to the DM inside the stdin payload,
 * after the card, as one JSON line per file, so the payload digest the
 * transmission intent records (§10) covers every byte of the snapshot and the
 * card's text cannot forge a file line.
 *
 * Target: the typed ask carries no worker HEAD, so §5's first source does not
 * exist and the target is `develop`'s public head, looked up once and checked
 * like any target (40 lowercase hex, the commit lookup answers with that id).
 * Anything else -- network, 5xx, rate limit, shape, a truncated tree -- is no
 * snapshot: the card goes alone.
 *
 * Files: the card's context paths and the paths its options declare, deduped,
 * in the order the card gives them. A path is refused by §5's grammar, by the
 * secret path list, when the tree has no regular-file blob for it, when its
 * bytes are not the tree's blob, when it is binary or not UTF-8, when the
 * secret scan finds anything, or when it is over 256 KiB; a file that would
 * take the snapshot's payload lines past 512 KiB is left out too (§5 allows up
 * to 2 MiB; less is sent so the payload stays within the broker's line caps
 * and a vendor's context). What was left out is recorded
 * as counts per reason, never as paths or content.
 */

export const DM_SNAPSHOT_REPOSITORY = "mposition/Tomverse";
export const DM_SNAPSHOT_TARGET_BRANCH = "develop";
export const DM_SNAPSHOT_API_ORIGIN = "https://api.github.com";
export const DM_SNAPSHOT_RAW_ORIGIN = "https://raw.githubusercontent.com";
export const DM_SNAPSHOT_FILE_MAX_BYTES = 256 * 1024;
/** The snapshot's payload lines, escaped as sent. */
export const DM_SNAPSHOT_TOTAL_MAX_BYTES = 512 * 1024;
/** §5: at most 64 context paths; the options' paths come on top, bounded by the card's own size cap. */
export const DM_SNAPSHOT_PATHS_MAX = 128;
/** One HTTP answer; a tree of a large repository is a few MiB. */
export const DM_SNAPSHOT_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
export const DM_SNAPSHOT_REQUEST_TIMEOUT_MS = 15_000;
/** The whole snapshot; files not read by then are left out, so a card never waits long on it. */
export const DM_SNAPSHOT_BUDGET_MS = 60_000;

export const DM_SNAPSHOT_EXCLUSIONS = [
  "path_refused",
  "secret_path",
  "not_in_tree",
  "not_a_file",
  "fetch_failed",
  "blob_mismatch",
  "binary",
  "secret_content",
  "file_too_large",
  "total_too_large",
  "time_budget",
] as const;
export type DmSnapshotExclusion = (typeof DM_SNAPSHOT_EXCLUSIONS)[number];

export const DM_SNAPSHOT_NONE_REASONS = [
  "no_paths",
  "target_unavailable",
  "tree_unavailable",
  "tree_truncated",
  "no_files",
] as const;
export type DmSnapshotNoneReason = (typeof DM_SNAPSHOT_NONE_REASONS)[number];

export type DmSnapshotFile = { path: string; blobId: string; text: string };

export type DmSnapshot =
  | { state: "none"; reason: DmSnapshotNoneReason; excluded: Partial<Record<DmSnapshotExclusion, number>> }
  | {
      state: "develop";
      targetSha: string;
      files: DmSnapshotFile[];
      excluded: Partial<Record<DmSnapshotExclusion, number>>;
    };

/** Git's blob id of these bytes. */
export const gitBlobId = (bytes: Uint8Array): string =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The file's text, or null when it is binary (a NUL byte) or not UTF-8. */
export const snapshotText = (bytes: Uint8Array): string | null => {
  if (bytes.includes(0)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
};

/** The card's paths in its own order, deduped, bounded. */
export const snapshotPathsFor = (contextPaths: readonly string[], optionPaths: readonly (readonly string[])[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of [...contextPaths, ...optionPaths.flat()]) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length === DM_SNAPSHOT_PATHS_MAX) break;
  }
  return out;
};

/** The tree's regular-file blobs by path, or null when the tree answer is not a tree. */
export const snapshotTreeBlobs = (
  tree: unknown,
): { truncated: boolean; entries: Map<string, { mode: string; type: string; sha: string }> } | null => {
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) return null;
  const record = tree as { truncated?: unknown; tree?: unknown };
  if (typeof record.truncated !== "boolean" || !Array.isArray(record.tree)) return null;
  const entries = new Map<string, { mode: string; type: string; sha: string }>();
  for (const entry of record.tree) {
    if (entry === null || typeof entry !== "object") return null;
    const { path, mode, type, sha } = entry as Record<string, unknown>;
    if (typeof path !== "string" || typeof mode !== "string" || typeof type !== "string" || typeof sha !== "string") return null;
    entries.set(path, { mode, type, sha });
  }
  return { truncated: record.truncated, entries };
};

/** How a snapshot reads its bytes. Every call is a public, unauthenticated GET. */
export type DmSnapshotHttp = (url: string) => Promise<{ status: number; body: Uint8Array } | null>;

const json = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

const count = (excluded: Partial<Record<DmSnapshotExclusion, number>>, reason: DmSnapshotExclusion) => {
  excluded[reason] = (excluded[reason] ?? 0) + 1;
};

/**
 * Build the snapshot for these paths. `http` is the only way out; the broker
 * passes the credential-free client (dmSnapshotHttpClient), a test passes a
 * fake. It never throws for a remote failure: those are `none` or an
 * exclusion.
 */
export async function buildDmSnapshot(
  paths: readonly string[],
  http: DmSnapshotHttp,
  now: () => number = Date.now,
): Promise<DmSnapshot> {
  const deadline = now() + DM_SNAPSHOT_BUDGET_MS;
  const excluded: Partial<Record<DmSnapshotExclusion, number>> = {};
  const wanted: string[] = [];
  for (const path of paths) {
    if (repositoryPathRefusal(path) !== null) count(excluded, "path_refused");
    else if (isSecretRepositoryPath(path)) count(excluded, "secret_path");
    else wanted.push(path);
  }
  if (wanted.length === 0) return { state: "none", reason: "no_paths", excluded };

  const api = `${DM_SNAPSHOT_API_ORIGIN}/repos/${DM_SNAPSHOT_REPOSITORY}`;
  // The target: develop's public head, looked up once and never re-resolved.
  const head = await http(`${api}/commits/${DM_SNAPSHOT_TARGET_BRANCH}`).catch(() => null);
  const headSha = head?.status === 200 ? (json(head.body) as { sha?: unknown } | null)?.sha : null;
  if (typeof headSha !== "string" || !isSnapshotTargetSha(headSha)) {
    return { state: "none", reason: "target_unavailable", excluded };
  }
  const commit = await http(`${api}/commits/${headSha}`).catch(() => null);
  const commitSha = commit?.status === 200 ? (json(commit.body) as { sha?: unknown } | null)?.sha : null;
  if (commitSha !== headSha) return { state: "none", reason: "target_unavailable", excluded };

  const treeAnswer = await http(`${api}/git/trees/${headSha}?recursive=1`).catch(() => null);
  const tree = treeAnswer?.status === 200 ? snapshotTreeBlobs(json(treeAnswer.body)) : null;
  if (tree === null) return { state: "none", reason: "tree_unavailable", excluded };
  if (tree.truncated) return { state: "none", reason: "tree_truncated", excluded };

  const files: DmSnapshotFile[] = [];
  let total = 0;
  for (const path of wanted) {
    if (now() >= deadline) {
      count(excluded, "time_budget");
      continue;
    }
    const entry = tree.entries.get(path);
    if (!entry) {
      count(excluded, "not_in_tree");
      continue;
    }
    if (entry.type !== "blob" || !isFetchableTreeMode(entry.mode)) {
      count(excluded, "not_a_file");
      continue;
    }
    const raw = await http(`${DM_SNAPSHOT_RAW_ORIGIN}/${DM_SNAPSHOT_REPOSITORY}/${headSha}/${encodeRepositoryPath(path)}`).catch(() => null);
    if (raw?.status !== 200) {
      count(excluded, "fetch_failed");
      continue;
    }
    if (gitBlobId(raw.body) !== entry.sha) {
      count(excluded, "blob_mismatch");
      continue;
    }
    if (raw.body.length > DM_SNAPSHOT_FILE_MAX_BYTES) {
      count(excluded, "file_too_large");
      continue;
    }
    const text = snapshotText(raw.body);
    if (text === null) {
      count(excluded, "binary");
      continue;
    }
    if (detectSecretsInFields({ text }).length > 0) {
      count(excluded, "secret_content");
      continue;
    }
    const lineBytes = Buffer.byteLength(snapshotFileLine({ path, blobId: entry.sha, text }));
    if (total + lineBytes > DM_SNAPSHOT_TOTAL_MAX_BYTES) {
      count(excluded, "total_too_large");
      continue;
    }
    total += lineBytes;
    files.push({ path, blobId: entry.sha, text });
  }
  if (files.length === 0) return { state: "none", reason: "no_files", excluded };
  return { state: "develop", targetSha: headSha, files, excluded };
}

const snapshotFileLine = (file: DmSnapshotFile) => `${JSON.stringify({ file: file.path, blob: file.blobId, text: file.text })}\n`;

/**
 * The snapshot's part of the stdin payload: one JSON line naming the commit,
 * then one JSON line per file. Every newline inside a string is escaped, so a
 * file's text cannot add a line of its own. Empty for no snapshot.
 */
export const dmSnapshotPayloadLines = (snapshot: DmSnapshot): string => {
  if (snapshot.state === "none") return "";
  const head = JSON.stringify({
    snapshot: { repository: `github.com/${DM_SNAPSHOT_REPOSITORY}`, commit: snapshot.targetSha, files: snapshot.files.length },
  });
  return `${head}\n${snapshot.files.map(snapshotFileLine).join("")}`;
};

/** §10's transmission fields for this snapshot, under the request key. */
export const dmSnapshotTransmission = (requestKey: Buffer, snapshot: DmSnapshot) =>
  snapshot.state === "none"
    ? { snapshotState: "none" as const, snapshotTargetSha: null, snapshotManifestDigest: null }
    : {
        snapshotState: snapshot.state,
        snapshotTargetSha: snapshot.targetSha,
        snapshotManifestDigest: dmSnapshotManifestDigest(
          requestKey,
          snapshot.files.map((file) => ({ path: file.path, blobId: file.blobId })),
        ),
      };

/**
 * The credential-free client: a bare `fetch` with no cookie, no auth header
 * and no proxy credential, to the two public hosts only, following no
 * redirect, with a deadline and a size cap. Nothing from the environment is
 * read.
 */
export const dmSnapshotHttpClient: DmSnapshotHttp = async (url) => {
  const target = new URL(url);
  if (target.protocol !== "https:" || (target.origin !== DM_SNAPSHOT_API_ORIGIN && target.origin !== DM_SNAPSHOT_RAW_ORIGIN)) {
    return null;
  }
  const response = await fetch(target, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    headers: { accept: target.origin === DM_SNAPSHOT_API_ORIGIN ? "application/vnd.github+json" : "*/*", "user-agent": "tomverse-amux-dm-broker" },
    signal: AbortSignal.timeout(DM_SNAPSHOT_REQUEST_TIMEOUT_MS),
  });
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > DM_SNAPSHOT_RESPONSE_MAX_BYTES) return { status: 413, body: new Uint8Array() };
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length > DM_SNAPSHOT_RESPONSE_MAX_BYTES) return { status: 413, body: new Uint8Array() };
  return { status: response.status, body };
};
