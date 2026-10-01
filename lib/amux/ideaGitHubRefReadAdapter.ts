import type {
  AmuxCommitComparison,
  AmuxGitTagObservation,
  AmuxListedRef,
  AmuxOwnedRefNamespace,
  AmuxOwnedRefPage,
  AmuxOwnedRefSearchAdapter,
  AmuxOwnedRefSearchLimits,
  AmuxOwnedRefSearchResult,
} from "./ideaOwnedRefSearchCore.ts";
import { searchAmuxOwnedRefWitness } from "./ideaOwnedRefSearchCore.ts";
import type {
  AmuxGitHubFileAtCommitAdapter,
  AmuxGitHubTreeEntry,
} from "./ideaGitHubFileAtCommitCore.ts";

/**
 * A dark read-only GitHub adapter. Only a separate, credential-isolated
 * collector may construct it. Never import it into the model CLI process or
 * pass its token to a child process. No app route currently invokes it.
 */
const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 8_000;
/** Provisional dark-path bound; live S0 must validate or revise it. */
const COLLECTION_TIMEOUT_MS = 30_000;
const MAX_GRAPHQL_BYTES = 256 * 1024;
const MAX_REST_BYTES = 512 * 1024;
const MAX_FILE_JSON_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const NAME = /^[A-Za-z0-9_.-]+$/;

const REF_LIST_QUERY = `query AmuxIdeaRefs($owner:String!, $name:String!, $prefix:String!, $after:String) {
  repository(owner:$owner, name:$name) {
    databaseId
    refs(refPrefix:$prefix, first:100, after:$after) {
      pageInfo { hasNextPage endCursor }
      nodes { name prefix target { __typename oid } }
    }
  }
}`;
const REF_READ_QUERY = `query AmuxIdeaRef($owner:String!, $name:String!, $qualifiedName:String!) {
  repository(owner:$owner, name:$name) {
    databaseId
    ref(qualifiedName:$qualifiedName) {
      name prefix target { __typename oid }
    }
  }
}`;

export class AmuxIdeaGitHubReadError extends Error {
  readonly code:
    | "invalid_collector_config" | "transport_error" | "http_error"
    | "oversized_response" | "invalid_response" | "wrong_repository";

  constructor(code: AmuxIdeaGitHubReadError["code"]) {
    // Never include upstream response text, URLs, ref names or credentials.
    super(code);
    this.code = code;
    this.name = "AmuxIdeaGitHubReadError";
  }
}

type FetchLike = typeof fetch;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : null;
const validSha = (value: unknown): value is string =>
  typeof value === "string" && SHA.test(value);
const validId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const validName = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength &&
  value !== "." && value !== ".." && NAME.test(value);
const fail = (code: AmuxIdeaGitHubReadError["code"]): never => {
  throw new AmuxIdeaGitHubReadError(code);
};

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return fail("http_error");
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) {
    void response.body?.cancel().catch(() => undefined);
    return fail("invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) return fail("invalid_response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) return fail("oversized_response");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof AmuxIdeaGitHubReadError) throw error;
    return fail("transport_error");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("invalid_response");
  }
}

export type AmuxIdeaGitHubRefAdapterConfig = {
  owner: string;
  repo: string;
  expectedRepositoryId: number;
  /** Dedicated Contents/Pull requests read token; no write or Workflows grant. */
  token: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
};

export type AmuxIdeaGitHubRefReader = {
  adapter: AmuxOwnedRefSearchAdapter;
  /** REST observations for the separate exact-file byte verification core. */
  fileAdapter: AmuxGitHubFileAtCommitAdapter;
  /** Check the stable numeric ID before collection and again before transfer. */
  readRepositoryIdentity: () => Promise<{ id: number; fullName: string }>;
};

export function createAmuxIdeaGitHubRefReader(
  config: AmuxIdeaGitHubRefAdapterConfig,
): AmuxIdeaGitHubRefReader {
  if (!config || !validName(config.owner, 64) || !validName(config.repo, 100) ||
      !validId(config.expectedRepositoryId) || typeof config.token !== "string" ||
      !config.token.trim() || /[\r\n]/.test(config.token) ||
      (config.fetchImpl !== undefined && typeof config.fetchImpl !== "function")) {
    return fail("invalid_collector_config");
  }
  const owner = config.owner;
  const repo = config.repo;
  const expectedRepositoryId = config.expectedRepositoryId;
  const token = config.token;
  const fetchImpl = config.fetchImpl ?? fetch;
  const overallSignal = config.signal
    ? AbortSignal.any([config.signal, AbortSignal.timeout(COLLECTION_TIMEOUT_MS)])
    : AbortSignal.timeout(COLLECTION_TIMEOUT_MS);
  const repositoryPath = `/repos/${owner}/${repo}`;
  const expectedName = `${owner}/${repo}`.toLowerCase();

  async function request(path: string, body?: unknown, maxBytes = MAX_REST_BYTES): Promise<unknown> {
    const signal = AbortSignal.any([overallSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let response: Response;
    try {
      response = await fetchImpl(`${API_ORIGIN}${path}`, {
        method: body === undefined ? "GET" : "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
      });
    } catch {
      return fail("transport_error");
    }
    return boundedJson(response, maxBytes);
  }

  async function graphql(query: string, variables: RecordValue): Promise<RecordValue> {
    const envelope = record(await request("/graphql", { query, variables }, MAX_GRAPHQL_BYTES));
    if (!envelope || envelope.errors !== undefined) return fail("invalid_response");
    const data = record(envelope.data);
    const repository = record(data?.repository);
    if (!repository || repository.databaseId !== expectedRepositoryId) {
      return fail("wrong_repository");
    }
    return repository;
  }

  const parseRef = (value: unknown, namespace: AmuxOwnedRefNamespace): AmuxListedRef => {
    const ref = record(value);
    const target = record(ref?.target);
    if (!ref || !target || ref.prefix !== namespace || typeof ref.name !== "string" ||
        ref.name.length === 0 || !validSha(target.oid) ||
        (target.__typename !== "Commit" && target.__typename !== "Tag") ||
        (namespace === "refs/heads/" && target.__typename !== "Commit")) {
      return fail("invalid_response");
    }
    return {
      name: `${namespace}${ref.name}`,
      objectType: target.__typename === "Commit" ? "commit" : "tag",
      objectSha: target.oid,
      // A matching legacy branch rule is not proof of effective protection;
      // rulesets and bypass actors also matter. Keep this display signal unknown.
      protected: null,
    };
  };

  const adapter: AmuxOwnedRefSearchAdapter = {
    async listRefs(namespace, after): Promise<AmuxOwnedRefPage> {
      const repository = await graphql(REF_LIST_QUERY, {
        owner, name: repo, prefix: namespace, after,
      });
      const connection = record(repository.refs);
      const pageInfo = record(connection?.pageInfo);
      if (!connection || !pageInfo || !Array.isArray(connection.nodes) ||
          typeof pageInfo.hasNextPage !== "boolean" ||
          (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string") ||
          (pageInfo.hasNextPage && !pageInfo.endCursor)) {
        return fail("invalid_response");
      }
      return {
        repositoryId: expectedRepositoryId,
        refs: connection.nodes.map((node: unknown) => parseRef(node, namespace)),
        hasNextPage: pageInfo.hasNextPage,
        endCursor: pageInfo.endCursor,
      };
    },
    async readTag(sha): Promise<AmuxGitTagObservation> {
      if (!validSha(sha)) return fail("invalid_response");
      const tag = record(await request(`${repositoryPath}/git/tags/${sha}`));
      const object = record(tag?.object);
      if (!tag || !object || tag.sha !== sha || !validSha(object.sha) ||
          !["commit", "tag", "tree", "blob"].includes(String(object.type))) {
        return fail("invalid_response");
      }
      return {
        repositoryId: expectedRepositoryId,
        sha,
        targetType: object.type as AmuxGitTagObservation["targetType"],
        targetSha: object.sha,
      };
    },
    async compareCommits(baseSha, headSha): Promise<AmuxCommitComparison> {
      if (!validSha(baseSha) || !validSha(headSha)) return fail("invalid_response");
      const head = record(await request(`${repositoryPath}/git/commits/${headSha}`));
      const comparePath = `${repositoryPath}/compare/${baseSha}...${headSha}`;
      const comparison = record(await request(`${comparePath}?per_page=1&page=1`));
      const base = record(comparison?.base_commit);
      const mergeBase = record(comparison?.merge_base_commit);
      if (!head || !comparison || !base || !mergeBase ||
          head.sha !== headSha || !validSha(base.sha) || !validSha(mergeBase.sha) ||
          !["ahead", "behind", "diverged", "identical"].includes(String(comparison.status)) ||
          !Number.isSafeInteger(comparison.ahead_by) ||
          !Number.isSafeInteger(comparison.behind_by) ||
          !Number.isSafeInteger(comparison.total_commits) ||
          !Array.isArray(comparison.commits)) {
        return fail("invalid_response");
      }
      if (comparison.status === "identical" &&
          (base.sha !== headSha || comparison.ahead_by !== 0 ||
           comparison.total_commits !== 0 || comparison.commits.length !== 0)) {
        return fail("invalid_response");
      }
      if (comparison.status === "ahead") {
        const aheadBy = comparison.ahead_by as number;
        if (aheadBy <= 0 || comparison.total_commits !== aheadBy) return fail("invalid_response");
        const finalPage = aheadBy === 1 ? comparison :
          record(await request(`${comparePath}?per_page=1&page=${aheadBy}`));
        const finalBase = record(finalPage?.base_commit);
        const finalMergeBase = record(finalPage?.merge_base_commit);
        if (!finalPage || !finalBase || !finalMergeBase ||
            finalPage.status !== comparison.status ||
            finalPage.ahead_by !== comparison.ahead_by ||
            finalPage.behind_by !== comparison.behind_by ||
            finalPage.total_commits !== comparison.total_commits ||
            finalBase.sha !== base.sha || finalMergeBase.sha !== mergeBase.sha ||
            !Array.isArray(finalPage.commits) || finalPage.commits.length !== 1 ||
            record(finalPage.commits[0])?.sha !== headSha) {
          return fail("invalid_response");
        }
      }
      return {
        repositoryId: expectedRepositoryId,
        baseSha: base.sha,
        headSha: head.sha,
        mergeBaseSha: mergeBase.sha,
        status: comparison.status as AmuxCommitComparison["status"],
        aheadBy: comparison.ahead_by as number,
        behindBy: comparison.behind_by as number,
      };
    },
    async readRef(name): Promise<AmuxListedRef & { repositoryId: number }> {
      const namespace = name.startsWith("refs/heads/") ? "refs/heads/"
        : name.startsWith("refs/tags/") ? "refs/tags/" : null;
      if (!namespace) return fail("invalid_response");
      const repository = await graphql(REF_READ_QUERY, {
        owner, name: repo, qualifiedName: name,
      });
      const current = parseRef(repository.ref, namespace);
      if (current.name !== name) return fail("invalid_response");
      return { ...current, repositoryId: expectedRepositoryId };
    },
  };

  const fileAdapter: AmuxGitHubFileAtCommitAdapter = {
    async readCommit(sha) {
      if (!validSha(sha)) return fail("invalid_response");
      const commit = record(await request(`${repositoryPath}/git/commits/${sha}`));
      const tree = record(commit?.tree);
      if (!commit || !tree || commit.sha !== sha || !validSha(tree.sha) ||
          tree.sha.length !== sha.length) return fail("invalid_response");
      return { repositoryId: expectedRepositoryId, sha, treeSha: tree.sha };
    },
    async readTree(sha) {
      if (!validSha(sha)) return fail("invalid_response");
      // Deliberately omit `recursive`: even `recursive=0` means recursive in GitHub's API.
      const tree = record(await request(`${repositoryPath}/git/trees/${sha}`));
      if (!tree || tree.sha !== sha || typeof tree.truncated !== "boolean" ||
          !Array.isArray(tree.tree)) return fail("invalid_response");
      const entries = tree.tree.map((raw: unknown): AmuxGitHubTreeEntry => {
        const entry = record(raw);
        if (!entry || typeof entry.path !== "string" || typeof entry.mode !== "string" ||
            !["tree", "blob", "commit"].includes(String(entry.type)) || !validSha(entry.sha) ||
            (entry.size !== undefined && entry.size !== null &&
             (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0))) {
          return fail("invalid_response");
        }
        return {
          path: entry.path,
          mode: entry.mode,
          type: entry.type as AmuxGitHubTreeEntry["type"],
          sha: entry.sha,
          // GitHub omits size for trees and gitlinks; the core requires null.
          size: entry.size === undefined ? null : entry.size as number | null,
        };
      });
      return { repositoryId: expectedRepositoryId, sha, truncated: tree.truncated, entries };
    },
    async readBlob(sha) {
      if (!validSha(sha)) return fail("invalid_response");
      const blob = record(await request(`${repositoryPath}/git/blobs/${sha}`, undefined, MAX_FILE_JSON_BYTES));
      if (!blob || blob.sha !== sha || blob.encoding !== "base64" ||
          typeof blob.content !== "string" || !Number.isSafeInteger(blob.size) ||
          (blob.size as number) < 0 || (blob.size as number) > MAX_FILE_BYTES) {
        return fail("invalid_response");
      }
      const compact = blob.content.replace(/[\r\n]/g, "");
      if (compact.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 ||
          compact.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]*={0,2})$/.test(compact)) {
        return fail("invalid_response");
      }
      const bytes = Buffer.from(compact, "base64");
      if (bytes.byteLength !== blob.size || bytes.toString("base64") !== compact) {
        return fail("invalid_response");
      }
      return { repositoryId: expectedRepositoryId, sha, size: blob.size as number, bytes };
    },
  };

  return {
    adapter,
    fileAdapter,
    async readRepositoryIdentity() {
      const repo = record(await request(repositoryPath));
      if (!repo || repo.id !== expectedRepositoryId ||
          typeof repo.full_name !== "string" || repo.full_name.toLowerCase() !== expectedName) {
        return fail("wrong_repository");
      }
      return { id: repo.id, fullName: repo.full_name };
    },
  };
}

/**
 * Mandatory identity envelope around the witness search. This still grants no
 * lasting authorization: the same repository, ref and bytes must be checked
 * again immediately before the one-time model transfer.
 */
export async function collectAmuxGitHubOwnedRefWitness(
  config: AmuxIdeaGitHubRefAdapterConfig,
  targetCommitSha: string,
  limits: AmuxOwnedRefSearchLimits,
): Promise<AmuxOwnedRefSearchResult> {
  let inspectedRefs = 0;
  try {
    const reader = createAmuxIdeaGitHubRefReader(config);
    await reader.readRepositoryIdentity();
    const result = await searchAmuxOwnedRefWitness(
      config.expectedRepositoryId, targetCommitSha, limits, reader.adapter,
    );
    inspectedRefs = result.inspectedRefs;
    if (result.status !== "verified_witness") return result;
    await reader.readRepositoryIdentity();
    return result;
  } catch (error) {
    return {
      status: "hold",
      reason: error instanceof AmuxIdeaGitHubReadError ? error.code : "repository_identity_unverified",
      inspectedRefs,
    };
  }
}
