import { createHash } from "node:crypto";

/**
 * Content-verifies the blob bytes of one small, regular UTF-8 file. The
 * commit-to-path links and repository ID are authenticated adapter observations,
 * not locally rehashed Git commit/tree objects. A separate owned-ref witness,
 * access check, secret scan, owner preview and one-time send approval are all
 * required before these bytes may leave the collector.
 *
 * The adapter is trusted, authenticated read-only GitHub I/O. Never accept
 * its observations from a model, browser payload or arbitrary request body.
 */
export type AmuxGitHubCommitObservation = {
  repositoryId: number;
  sha: string;
  treeSha: string;
};

export type AmuxGitHubTreeEntry = {
  path: string;
  mode: string;
  type: "tree" | "blob" | "commit";
  sha: string;
  /** Normalize an omitted GitHub tree/commit size to null in the adapter. */
  size: number | null;
};

export type AmuxGitHubTreeObservation = {
  repositoryId: number;
  sha: string;
  truncated: boolean;
  entries: readonly AmuxGitHubTreeEntry[];
};

export type AmuxGitHubBlobObservation = {
  repositoryId: number;
  sha: string;
  size: number;
  bytes: Uint8Array;
};

export type AmuxGitHubFileAtCommitAdapter = {
  readCommit: (sha: string) => Promise<AmuxGitHubCommitObservation>;
  readTree: (sha: string) => Promise<AmuxGitHubTreeObservation>;
  readBlob: (sha: string) => Promise<AmuxGitHubBlobObservation>;
};

export type AmuxGitHubFileAtCommitResult =
  | {
      status: "verified_file";
      repositoryId: number;
      commitSha: string;
      path: string;
      blobSha: string;
      size: number;
      sha256: string;
      /** Exact UTF-8 interpretation, with BOM and line endings preserved. */
      text: string;
    }
  | { status: "hold"; reason: string }
  | { status: "reject"; reason: string };

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_COMPONENT = /^[A-Za-z0-9_.-]+$/;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 512;
const MAX_SEGMENTS = 32;

const validSha = (value: unknown): value is string =>
  typeof value === "string" && SHA.test(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const nonNegative = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function splitSafePath(path: unknown): string[] | null {
  if (typeof path !== "string" || !path || path.length > MAX_PATH_LENGTH ||
      path.startsWith("/") || path.includes("\\")) return null;
  const parts = path.split("/");
  if (parts.length > MAX_SEGMENTS || parts.some((part) =>
    part.length === 0 || part.length > 255 || part === "." || part === ".." ||
    !SAFE_COMPONENT.test(part))) return null;
  return parts;
}

function gitBlobSha(bytes: Uint8Array, algorithm: "sha1" | "sha256"): string {
  const hash = createHash(algorithm);
  hash.update(`blob ${bytes.byteLength}\0`, "utf8");
  hash.update(bytes);
  return hash.digest("hex");
}

function validTreeEntry(entry: AmuxGitHubTreeEntry): boolean {
  return !!entry && typeof entry.path === "string" && entry.path.length > 0 &&
    !entry.path.includes("/") && !entry.path.includes("\\") &&
    typeof entry.mode === "string" && validSha(entry.sha) &&
    ["tree", "blob", "commit"].includes(entry.type) &&
    (entry.size === null || nonNegative(entry.size));
}

/** A positive result is never authorization to send the text to a model. */
export async function verifyAmuxGitHubFileAtCommit(
  repositoryId: number,
  commitSha: string,
  path: string,
  adapter: AmuxGitHubFileAtCommitAdapter,
): Promise<AmuxGitHubFileAtCommitResult> {
  const hold = (reason: string): AmuxGitHubFileAtCommitResult => ({ status: "hold", reason });
  const reject = (reason: string): AmuxGitHubFileAtCommitResult => ({ status: "reject", reason });
  const parts = splitSafePath(path);
  if (!positive(repositoryId) || !validSha(commitSha)) return hold("invalid_file_contract");
  if (!parts) return reject("unsupported_file_path");

  try {
    if (!adapter || typeof adapter.readCommit !== "function" ||
        typeof adapter.readTree !== "function" ||
        typeof adapter.readBlob !== "function") return hold("invalid_file_contract");
    const commit = await adapter.readCommit(commitSha);
    if (!commit || commit.repositoryId !== repositoryId ||
        commit.sha !== commitSha || !validSha(commit.treeSha) ||
        commit.treeSha.length !== commitSha.length) return hold("commit_unverified");

    let treeSha = commit.treeSha;
    let blobSha: string | null = null;
    let declaredSize: number | null = null;
    for (let index = 0; index < parts.length; index++) {
      const tree = await adapter.readTree(treeSha);
      if (!tree || tree.repositoryId !== repositoryId || tree.sha !== treeSha ||
          tree.truncated !== false || !Array.isArray(tree.entries) ||
          tree.entries.some((entry) => !validTreeEntry(entry))) return hold("tree_unverified");
      const matches = tree.entries.filter((entry) => entry.path === parts[index]);
      if (matches.length !== 1) return hold("path_unverified");
      const entry = matches[0];
      if (entry.sha.length !== commitSha.length) return hold("tree_unverified");
      if (index < parts.length - 1) {
        if (entry.type !== "tree" || entry.mode !== "040000" || entry.size !== null) {
          return reject("non_regular_path");
        }
        treeSha = entry.sha;
      } else {
        if (entry.type !== "blob" ||
            (entry.mode !== "100644" && entry.mode !== "100755") ||
            !nonNegative(entry.size)) return reject("non_regular_file");
        if (entry.size > MAX_FILE_BYTES) return reject("file_too_large");
        blobSha = entry.sha;
        declaredSize = entry.size;
      }
    }
    if (!blobSha || declaredSize === null) return hold("path_unverified");
    const blob = await adapter.readBlob(blobSha);
    const rawBytes = blob?.bytes;
    if (!blob || blob.repositoryId !== repositoryId || blob.sha !== blobSha ||
        !nonNegative(blob.size) || blob.size !== declaredSize ||
        !(rawBytes instanceof Uint8Array) || rawBytes.byteLength !== declaredSize ||
        rawBytes.byteLength > MAX_FILE_BYTES) return hold("blob_unverified");

    // Copy first: a mutable adapter-owned buffer must not change after proof.
    const bytes = Uint8Array.from(rawBytes);
    const algorithm = blobSha.length === 40 ? "sha1" : "sha256";
    if (gitBlobSha(bytes, algorithm) !== blobSha) return hold("blob_digest_mismatch");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (text.includes("\0") ||
          !Buffer.from(text, "utf8").equals(Buffer.from(bytes))) return reject("non_text_file");
    } catch {
      return reject("non_text_file");
    }
    return {
      status: "verified_file", repositoryId, commitSha, path,
      blobSha, size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"), text,
    };
  } catch {
    return hold("collector_unavailable");
  }
}
