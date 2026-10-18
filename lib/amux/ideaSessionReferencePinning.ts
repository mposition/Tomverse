import type { IdeaInput } from "./ideaInputCore.ts";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REPO = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;
const validRepository = (value: string) => REPO.test(value) &&
  value.split("/").every((part) => part !== "." && part !== "..");
const MAX_RESPONSE_BYTES = 256 * 1024;
const READ_TIMEOUT_MS = 8_000;

export class AmuxSessionReferencePinningError extends Error {
  constructor() {
    super("reference_snapshot_unavailable");
    this.name = "AmuxSessionReferencePinningError";
  }
}

async function githubJson(path: string, token: string,
  fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const endpoint = `https://api.github.com${path}`;
  const response = await fetchImpl(endpoint, {
    method: "GET", redirect: "manual", cache: "no-store",
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    headers: { accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`, "user-agent": "tomverse-amux-intake",
      "x-github-api-version": "2022-11-28" },
  });
  if (response.status !== 200 || response.url && response.url !== endpoint ||
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json") throw new AmuxSessionReferencePinningError();
  const reader = response.body?.getReader();
  if (!reader) throw new AmuxSessionReferencePinningError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new AmuxSessionReferencePinningError();
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new AmuxSessionReferencePinningError();
      chunks.push(value);
    }
    const body = Buffer.concat(chunks, size);
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString("utf8")); }
    finally { body.fill(0); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AmuxSessionReferencePinningError();
    }
    return parsed as Record<string, unknown>;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    try { await reader.cancel(); } catch { /* No source data in diagnostics. */ }
    reader.releaseLock();
  }
}

/** Capture each allowed reference before the intake transaction. Only fixed
 * SHAs, in the submitted order, enter the append-only submission audit.
 * A fork head is outside the approved repository and is refused. */
export async function pinAmuxSessionReferences(input: IdeaInput, token: string | undefined,
  fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const references = [...input.repositories, ...input.pullRequests];
  if (references.length === 0) return [];
  if (typeof token !== "string" || !/^[^\s\u0000-\u001f]{20,512}$/.test(token)) {
    throw new AmuxSessionReferencePinningError();
  }
  const result: string[] = [];
  try {
    for (const repository of input.repositories) {
      if (!validRepository(repository)) throw new AmuxSessionReferencePinningError();
      const name = repository.split("/").map(encodeURIComponent).join("/");
      const metadata = await githubJson(`/repos/${name}`, token, fetchImpl);
      if (typeof metadata.full_name !== "string" ||
          metadata.full_name.toLowerCase() !== repository.toLowerCase()) {
        throw new AmuxSessionReferencePinningError();
      }
      const branch = metadata.default_branch;
      if (typeof branch !== "string" || branch.length < 1 || branch.length > 255 ||
          /[\u0000-\u001f\u007f]/.test(branch)) {
        throw new AmuxSessionReferencePinningError();
      }
      const commit = await githubJson(`/repos/${name}/commits/${encodeURIComponent(branch)}`,
        token, fetchImpl);
      if (typeof commit.sha !== "string" || !SHA.test(commit.sha)) {
        throw new AmuxSessionReferencePinningError();
      }
      result.push(commit.sha);
    }
    for (const pull of input.pullRequests) {
      if (!validRepository(pull.repository) || !Number.isSafeInteger(pull.number) ||
          pull.number < 1) throw new AmuxSessionReferencePinningError();
      const name = pull.repository.split("/").map(encodeURIComponent).join("/");
      const snapshot = await githubJson(`/repos/${name}/pulls/${pull.number}`,
        token, fetchImpl);
      const head = snapshot.head;
      if (!head || typeof head !== "object" || Array.isArray(head)) {
        throw new AmuxSessionReferencePinningError();
      }
      const values = head as Record<string, unknown>;
      const repo = values.repo;
      const headSha = values.sha;
      const headRepoName = repo && typeof repo === "object" && !Array.isArray(repo)
        ? (repo as Record<string, unknown>).full_name : null;
      if (typeof headSha !== "string" || !SHA.test(headSha) ||
          !repo || typeof repo !== "object" || Array.isArray(repo) ||
          typeof headRepoName !== "string" ||
          headRepoName.toLowerCase() !==
            pull.repository.toLowerCase()) throw new AmuxSessionReferencePinningError();
      result.push(headSha);
    }
    return result;
  } catch {
    throw new AmuxSessionReferencePinningError();
  }
}
