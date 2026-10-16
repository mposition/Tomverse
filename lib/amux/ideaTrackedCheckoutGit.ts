import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  AmuxTrackedCheckoutManifestError,
  planAmuxTrackedCheckout,
  type AmuxTrackedCheckoutManifest,
  type AmuxTrackedTreeEntry,
} from "./ideaTrackedCheckoutManifestCore.ts";

const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TREE_MODES = new Set(["100644", "100755", "120000", "160000", "40000"]);

function verifyGitObject(type: "commit" | "tree" | "blob", bytes: Buffer, objectId: string): void {
  const algorithm = objectId.length === 40 ? "sha1" : "sha256";
  const actual = createHash(algorithm)
    .update(`${type} ${bytes.length}\0`, "utf8")
    .update(bytes).digest("hex");
  if (actual !== objectId) throw new AmuxTrackedCheckoutManifestError();
}

/** Read-only local object access. The caller owns an already fetched repository;
 * this process never fetches or forwards its credentials to the analysis CLI. */
async function localGit(repositoryPath: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  if (typeof repositoryPath !== "string" || !isAbsolute(repositoryPath) ||
      repositoryPath.includes("\0") || signal?.aborted) {
    throw new AmuxTrackedCheckoutManifestError();
  }
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-optional-locks", "-C", repositoryPath, ...args], {
      shell: false,
      windowsHide: true,
      signal,
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "production",
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => reject(new AmuxTrackedCheckoutManifestError()));
    child.once("close", (code) => {
      if (code !== 0) reject(new AmuxTrackedCheckoutManifestError());
      else resolve(Buffer.concat(chunks));
    });
  });
}

function parseRawTree(bytes: Buffer, objectIdLength: number, prefix: string):
    { files: AmuxTrackedTreeEntry[]; childTrees: Array<{ path: string; objectId: string }> } {
  const files: AmuxTrackedTreeEntry[] = [];
  const childTrees: Array<{ path: string; objectId: string }> = [];
  const oidBytes = objectIdLength / 2;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const space = bytes.indexOf(32, offset);
      const nul = space < 0 ? -1 : bytes.indexOf(0, space + 1);
      if (space < 0 || nul < 0 || nul + 1 + oidBytes > bytes.length) {
        throw new AmuxTrackedCheckoutManifestError();
      }
      const mode = bytes.subarray(offset, space).toString("ascii");
      const name = decoder.decode(bytes.subarray(space + 1, nul));
      if (!TREE_MODES.has(mode) || !name || name.includes("/")) {
        throw new AmuxTrackedCheckoutManifestError();
      }
      const objectId = bytes.subarray(nul + 1, nul + 1 + oidBytes).toString("hex");
      const path = prefix + name;
      if (mode === "40000") childTrees.push({ path, objectId });
      else files.push({ path, mode,
        type: mode === "160000" ? "commit" : "blob", objectId });
      offset = nul + 1 + oidBytes;
    }
  } catch { throw new AmuxTrackedCheckoutManifestError(); }
  return { files, childTrees };
}

/** Enumerate one full pinned commit, never the mutable branch or worktree. */
export async function readAmuxPinnedTrackedTree(
  repositoryPath: string,
  commitSha: string,
  signal?: AbortSignal,
): Promise<AmuxTrackedCheckoutManifest> {
  if (typeof commitSha !== "string" || !COMMIT_SHA.test(commitSha)) {
    throw new AmuxTrackedCheckoutManifestError();
  }
  // An absent child directory must not silently select its enclosing repo.
  const prefix = await localGit(repositoryPath, ["rev-parse", "--show-prefix"], signal);
  if (prefix.toString("utf8").trim() !== "") throw new AmuxTrackedCheckoutManifestError();
  const commit = await localGit(repositoryPath, ["cat-file", "commit", commitSha], signal);
  verifyGitObject("commit", commit, commitSha);
  const firstLineEnd = commit.indexOf(10);
  const firstLine = firstLineEnd < 0 ? "" : commit.subarray(0, firstLineEnd).toString("ascii");
  const match = /^tree ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(firstLine);
  if (!match || match[1].length !== commitSha.length) {
    throw new AmuxTrackedCheckoutManifestError();
  }
  const entries: AmuxTrackedTreeEntry[] = [];
  const pending = [{ path: "", objectId: match[1] }];
  while (pending.length > 0) {
    const next = pending.pop()!;
    const tree = await localGit(repositoryPath, ["cat-file", "tree", next.objectId], signal);
    verifyGitObject("tree", tree, next.objectId);
    const parsed = parseRawTree(tree, commitSha.length, next.path);
    for (const file of parsed.files) entries.push(file);
    for (const child of parsed.childTrees) {
      pending.push({ path: `${child.path}/`, objectId: child.objectId });
    }
  }
  return planAmuxTrackedCheckout(entries);
}

/** Fetch one local object by content ID; Git is never asked to resolve a path
 * or a mutable ref here. The bytes are still untrusted until fully scanned. */
export async function readAmuxPinnedTrackedBlob(
  repositoryPath: string,
  objectId: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (typeof objectId !== "string" || !COMMIT_SHA.test(objectId)) {
    throw new AmuxTrackedCheckoutManifestError();
  }
  const bytes = await localGit(repositoryPath, ["cat-file", "blob", objectId], signal);
  verifyGitObject("blob", bytes, objectId);
  return bytes;
}
