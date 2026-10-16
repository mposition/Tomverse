import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import {
  AmuxTrackedCheckoutManifestError,
  planAmuxTrackedCheckout,
  type AmuxTrackedCheckoutManifest,
  type AmuxTrackedTreeEntry,
} from "./ideaTrackedCheckoutManifestCore.ts";

const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TREE_RECORD = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})$/;

/** Read-only local object access. The caller owns an already fetched repository;
 * this process never fetches or forwards its credentials to the analysis CLI. */
async function localGit(repositoryPath: string, args: string[]): Promise<Buffer> {
  if (typeof repositoryPath !== "string" || !repositoryPath || repositoryPath.includes("\0")) {
    throw new AmuxTrackedCheckoutManifestError();
  }
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-optional-locks", "-C", repositoryPath, ...args], {
      shell: false,
      windowsHide: true,
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

function parseGitTree(bytes: Buffer, objectIdLength: number): AmuxTrackedTreeEntry[] {
  if (bytes.length && bytes.at(-1) !== 0) throw new AmuxTrackedCheckoutManifestError();
  const entries: AmuxTrackedTreeEntry[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const end = bytes.indexOf(0, offset);
      if (end < 0) throw new AmuxTrackedCheckoutManifestError();
      const record = bytes.subarray(offset, end);
      const tab = record.indexOf(9);
      if (tab < 0) throw new AmuxTrackedCheckoutManifestError();
      const header = decoder.decode(record.subarray(0, tab));
      const match = TREE_RECORD.exec(header);
      if (!match || match[3].length !== objectIdLength) {
        throw new AmuxTrackedCheckoutManifestError();
      }
      entries.push({
        path: decoder.decode(record.subarray(tab + 1)),
        mode: match[1],
        type: match[2],
        objectId: match[3],
      });
      offset = end + 1;
    }
  } catch { throw new AmuxTrackedCheckoutManifestError(); }
  return entries;
}

/** Enumerate one full pinned commit, never the mutable branch or worktree. */
export async function readAmuxPinnedTrackedTree(
  repositoryPath: string,
  commitSha: string,
): Promise<AmuxTrackedCheckoutManifest> {
  if (typeof commitSha !== "string" || !COMMIT_SHA.test(commitSha)) {
    throw new AmuxTrackedCheckoutManifestError();
  }
  const objectType = await localGit(repositoryPath, ["cat-file", "-t", commitSha]);
  if (objectType.toString("ascii") !== "commit\n") {
    throw new AmuxTrackedCheckoutManifestError();
  }
  const tree = await localGit(repositoryPath, ["ls-tree", "-rz", "--full-tree", commitSha]);
  return planAmuxTrackedCheckout(parseGitTree(tree, commitSha.length));
}

/** Fetch one local object by content ID; Git is never asked to resolve a path
 * or a mutable ref here. The bytes are still untrusted until fully scanned. */
export async function readAmuxPinnedTrackedBlob(
  repositoryPath: string,
  objectId: string,
): Promise<Buffer> {
  if (typeof objectId !== "string" || !COMMIT_SHA.test(objectId)) {
    throw new AmuxTrackedCheckoutManifestError();
  }
  const bytes = await localGit(repositoryPath, ["cat-file", "blob", objectId]);
  const algorithm = objectId.length === 40 ? "sha1" : "sha256";
  const actual = createHash(algorithm)
    .update(`blob ${bytes.length}\0`, "utf8")
    .update(bytes).digest("hex");
  if (actual !== objectId) throw new AmuxTrackedCheckoutManifestError();
  return bytes;
}
