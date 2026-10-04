import type { IdeaInput } from "./ideaInputCore.ts";

/** A source-scope proposal names exact files and claimed Git revisions. These
 * are unverified claims, not an access approval. A separate read-only GitHub
 * collector must verify repo commit provenance, current PR base/head SHAs,
 * PR changed-file membership, regular-file blob mode and byte identity before
 * collection. Owner preview must render canonicalJson, never the raw JSON.
 * This module grants no GitHub read or external model transfer. */
export const AMUX_IDEA_SOURCE_SCOPE_VERSION = 1 as const;
export const AMUX_IDEA_SOURCE_SCOPE_MAX_BYTES = 16_384;
export const AMUX_IDEA_SOURCE_SCOPE_MAX_FILES = 64;

type RepositoryFile = {
  kind: "repository_file";
  repository: string;
  commitSha: string;
  path: string;
};

type PullRequestFile = {
  kind: "pull_request_file";
  repository: string;
  number: number;
  baseSha: string;
  headSha: string;
  side: "base" | "head";
  path: string;
};

export type IdeaSourceFile = RepositoryFile | PullRequestFile;
export type IdeaSourceScopeProposal = {
  version: typeof AMUX_IDEA_SOURCE_SCOPE_VERSION;
  sources: IdeaSourceFile[];
};

export type IdeaSourceScopeInspection =
  | { ok: true; canonicalJson: string; fileCount: number; collectionVerified: false }
  | { ok: false; code: "schema_rejected" | "too_large" | "metadata_incomplete" | "outside_idea_sources" };

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;
const PATH = /^[A-Za-z0-9._/-]{1,256}$/;

const exactKeys = (value: Record<string, unknown>, names: readonly string[]) => {
  const keys = Object.keys(value).sort();
  const expected = [...names].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};

const validRepository = (value: unknown): value is string =>
  typeof value === "string" && REPOSITORY.test(value) &&
  value.split("/").every((part) => part !== "." && part !== "..");

const validPath = (value: unknown): value is string =>
  typeof value === "string" && PATH.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");

const validSha = (value: unknown): value is string =>
  typeof value === "string" && SHA.test(value);

const identity = (source: IdeaSourceFile) => source.kind === "repository_file"
  ? `r\0${source.repository.toLowerCase()}\0${source.commitSha}\0${source.path}`
  : `p\0${source.repository.toLowerCase()}\0${source.number}\0${source.baseSha}\0${source.headSha}\0${source.side}\0${source.path}`;

export function inspectAmuxIdeaSourceScope(raw: string, declared: IdeaInput): IdeaSourceScopeInspection {
  if (Buffer.byteLength(raw, "utf8") > AMUX_IDEA_SOURCE_SCOPE_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "schema_rejected" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "schema_rejected" };
  }
  const record = parsed as Record<string, unknown>;
  if (!exactKeys(record, ["version", "sources"]) || record.version !== AMUX_IDEA_SOURCE_SCOPE_VERSION ||
      !Array.isArray(record.sources)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (record.sources.length === 0) return { ok: false, code: "metadata_incomplete" };
  if (record.sources.length > AMUX_IDEA_SOURCE_SCOPE_MAX_FILES) {
    return { ok: false, code: "too_large" };
  }

  const repositories = new Map(declared.repositories.map((repository) => [repository.toLowerCase(), repository]));
  const pullRequests = new Map(declared.pullRequests.map((pr) =>
    [`${pr.repository.toLowerCase()}#${pr.number}`, pr]));
  if (repositories.size !== declared.repositories.length || pullRequests.size !== declared.pullRequests.length) {
    return { ok: false, code: "schema_rejected" };
  }
  const sources: IdeaSourceFile[] = [];
  for (const candidate of record.sources) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { ok: false, code: "schema_rejected" };
    }
    const item = candidate as Record<string, unknown>;
    if (!validRepository(item.repository) || !validPath(item.path)) {
      return { ok: false, code: "schema_rejected" };
    }
    if (item.kind === "repository_file") {
      if (!exactKeys(item, ["kind", "repository", "commitSha", "path"]) || !validSha(item.commitSha)) {
        return { ok: false, code: "schema_rejected" };
      }
      const repository = repositories.get(item.repository.toLowerCase());
      if (!repository) return { ok: false, code: "outside_idea_sources" };
      sources.push({ kind: "repository_file", repository, commitSha: item.commitSha, path: item.path });
    } else if (item.kind === "pull_request_file") {
      if (!exactKeys(item, ["kind", "repository", "number", "baseSha", "headSha", "side", "path"]) ||
          !Number.isSafeInteger(item.number) || (item.number as number) <= 0 ||
          !validSha(item.baseSha) || !validSha(item.headSha) ||
          (item.side !== "base" && item.side !== "head")) {
        return { ok: false, code: "schema_rejected" };
      }
      const pr = pullRequests.get(`${item.repository.toLowerCase()}#${item.number}`);
      if (!pr) return { ok: false, code: "outside_idea_sources" };
      sources.push({
        kind: "pull_request_file", repository: pr.repository, number: pr.number,
        baseSha: item.baseSha, headSha: item.headSha, side: item.side, path: item.path,
      });
    } else {
      return { ok: false, code: "schema_rejected" };
    }
  }
  const names = sources.map(identity);
  if (new Set(names).size !== names.length) return { ok: false, code: "schema_rejected" };
  sources.sort((a, b) => identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0);
  const proposal: IdeaSourceScopeProposal = { version: AMUX_IDEA_SOURCE_SCOPE_VERSION, sources };
  const canonicalJson = JSON.stringify(proposal);
  if (Buffer.byteLength(canonicalJson, "utf8") > AMUX_IDEA_SOURCE_SCOPE_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  return { ok: true, canonicalJson, fileCount: sources.length, collectionVerified: false };
}
