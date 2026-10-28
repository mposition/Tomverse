import "server-only";

import type { AmuxGitHubFileAtCommitAdapter,
  AmuxGitHubTreeEntry } from "./amux/ideaGitHubFileAtCommitCore";
import type { ChatUnifiedOptimizerPublicCollector } from
  "./chatUnifiedOptimizerCandidateGeneration";

const ORIGIN = "https://api.github.com";
const REPOSITORY_PATH = "/repos/mposition/Tomverse";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const COLLECTION_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SHA = /^[0-9a-f]{40}$/;

type Fetch = typeof fetch;

const fail = (): never => { throw new Error("optimizer_public_collector_unavailable"); };
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail();
  }
  return value as Record<string, unknown>;
};
const sha = (value: unknown): string =>
  typeof value === "string" && SHA.test(value) ? value : fail();
const safeSize = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : fail();

/**
 * Fixed unauthenticated GitHub reads for the public development set. No token,
 * cookie, arbitrary URL, private repository reader or candidate-supplied path
 * enters this adapter. The independent file verifier checks commit/tree/blob
 * links and hashes before any public example reaches candidate generation.
 */
export function createChatUnifiedOptimizerPublicCollector(input: Readonly<{
  repositoryId: number;
  fetchImpl?: Fetch;
  signal?: AbortSignal;
}>): ChatUnifiedOptimizerPublicCollector {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0 ||
      (input.fetchImpl !== undefined && typeof input.fetchImpl !== "function")) {
    return fail();
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const overallSignal = input.signal ? AbortSignal.any([
    input.signal, AbortSignal.timeout(COLLECTION_TIMEOUT_MS),
  ]) : AbortSignal.timeout(COLLECTION_TIMEOUT_MS);

  async function request(path: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      const signal = AbortSignal.any([overallSignal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
      response = await fetchImpl(`${ORIGIN}${REPOSITORY_PATH}${path}`, {
        method: "GET", credentials: "omit", redirect: "error",
        cache: "no-store", signal,
        headers: { Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (!response.ok || !response.body) return fail();
      const type = response.headers.get("content-type")?.split(";")[0]
        ?.trim().toLowerCase();
      if (type !== "application/json") return fail();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            return fail();
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks, size);
      return object(JSON.parse(new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)));
    } catch { return fail(); }
  }

  const fileAdapter: AmuxGitHubFileAtCommitAdapter = {
    async readCommit(commitSha) {
      const expectedSha = sha(commitSha);
      const commit = await request(`/git/commits/${expectedSha}`);
      const tree = object(commit.tree);
      if (commit.sha !== expectedSha) return fail();
      return { repositoryId: input.repositoryId, sha: expectedSha,
        treeSha: sha(tree.sha) };
    },
    async readTree(treeSha) {
      const expectedSha = sha(treeSha);
      const tree = await request(`/git/trees/${expectedSha}`);
      if (tree.sha !== expectedSha || tree.truncated !== false ||
          !Array.isArray(tree.tree)) return fail();
      const entries: AmuxGitHubTreeEntry[] = tree.tree.map(raw => {
        const entry = object(raw);
        if (typeof entry.path !== "string" ||
            typeof entry.mode !== "string" ||
            !["tree", "blob", "commit"].includes(String(entry.type))) {
          return fail();
        }
        return { path: entry.path, mode: entry.mode,
          type: entry.type as AmuxGitHubTreeEntry["type"], sha: sha(entry.sha),
          size: entry.size === undefined || entry.size === null ? null :
            safeSize(entry.size) };
      });
      return { repositoryId: input.repositoryId, sha: expectedSha,
        truncated: false, entries };
    },
    async readBlob(blobSha) {
      const expectedSha = sha(blobSha);
      const blob = await request(`/git/blobs/${expectedSha}`);
      const size = safeSize(blob.size);
      if (blob.sha !== expectedSha || blob.encoding !== "base64" ||
          typeof blob.content !== "string" || size > 64 * 1024) return fail();
      const encoded = blob.content.replace(/[\r\n]/g, "");
      if (encoded.length > Math.ceil(64 * 1024 / 3) * 4 ||
          encoded.length % 4 !== 0 ||
          !/^(?:[A-Za-z0-9+/]*={0,2})$/.test(encoded)) return fail();
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length !== size || bytes.toString("base64") !== encoded) {
        return fail();
      }
      return { repositoryId: input.repositoryId, sha: expectedSha,
        size, bytes };
    },
  };
  return Object.freeze({
    async readRepository() {
      const repository = await request("");
      if (repository.id !== input.repositoryId ||
          repository.full_name !== "mposition/Tomverse" ||
          repository.private !== false) return fail();
      return Object.freeze({ id: input.repositoryId,
        fullName: "mposition/Tomverse", private: false as const,
        authenticated: false as const });
    },
    fileAdapter,
  });
}
