import type { IdeaSourceFile } from "./ideaSourceScopeCore.ts";

/**
 * Consistency check for collector-owned GitHub REST observations, not a proof
 * that a browser/model supplied those observations. The read-only collector
 * must fetch the PR before and after its complete file page, bind numeric repo
 * identity, and re-fetch immediately before any one-time external transfer.
 * Fork PRs hold: base and head must both be the expected repository. The
 * GitHub's changed-file page is a three-dot merge-base/head diff. A base-side
 * source is eligible only when the observed base SHA equals that merge-base;
 * otherwise the page cannot prove membership at the current base SHA.
 * Callers must still verify the actual selected bytes at the immutable SHA.
 * The one-page/100-file bound is provisional and deliberately holds larger
 * PRs; GitHub's API caps the files response at 3,000, so count alone cannot
 * prove completeness above that ceiling.
 */
export const AMUX_V4_PR_FILE_LIST_MAX = 100;

export type AmuxPullRequestObservation = {
  repositoryId: number;
  number: number;
  baseRepositoryId: number;
  headRepositoryId: number;
  baseSha: string;
  headSha: string;
  changedFiles: number;
};

export type AmuxPullRequestFileEntry = {
  filename: string;
  status: string;
  /** Collector normalizes GitHub's absent previous_filename to null. */
  previousFilename: string | null;
};

export type AmuxPullRequestFilePage = {
  page: number;
  perPage: number;
  hasNext: boolean;
  files: readonly AmuxPullRequestFileEntry[];
};

export type AmuxPullRequestFileListResult =
  | {
      status: "complete";
      repositoryId: number;
      number: number;
      baseSha: string;
      headSha: string;
      mergeBaseSha: string;
      basePaths: readonly string[];
      headPaths: readonly string[];
    }
  | { status: "hold"; reason: string };

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const validId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const validPath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 1024 &&
  !/[\x00-\x1f\x7f-\x9f\\\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/iu.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const sameSnapshot = (a: AmuxPullRequestObservation, b: AmuxPullRequestObservation): boolean =>
  a.repositoryId === b.repositoryId && a.number === b.number &&
  a.baseRepositoryId === b.baseRepositoryId && a.headRepositoryId === b.headRepositoryId &&
  a.baseSha === b.baseSha && a.headSha === b.headSha && a.changedFiles === b.changedFiles;

export function inspectAmuxPullRequestFileList(
  before: AmuxPullRequestObservation,
  page: AmuxPullRequestFilePage,
  after: AmuxPullRequestObservation,
  mergeBaseSha: string,
): AmuxPullRequestFileListResult {
  const hold = (reason: string): AmuxPullRequestFileListResult => ({ status: "hold", reason });
  if (!before || !after || !page || !validId(before.repositoryId) ||
      !validId(before.number) || !validId(before.baseRepositoryId) ||
      !validId(before.headRepositoryId) ||
      before.baseRepositoryId !== before.repositoryId ||
      before.headRepositoryId !== before.repositoryId ||
      typeof before.baseSha !== "string" || !SHA.test(before.baseSha) ||
      typeof before.headSha !== "string" || !SHA.test(before.headSha) ||
      before.baseSha.length !== before.headSha.length ||
      !Number.isSafeInteger(before.changedFiles) || before.changedFiles < 1 ||
      before.changedFiles > AMUX_V4_PR_FILE_LIST_MAX ||
      !sameSnapshot(before, after)) return hold("pr_snapshot_unverified");
  if (typeof mergeBaseSha !== "string" || !SHA.test(mergeBaseSha) ||
      mergeBaseSha !== before.baseSha) return hold("pr_base_not_merge_base");
  if (page.page !== 1 || page.perPage !== AMUX_V4_PR_FILE_LIST_MAX || page.hasNext !== false ||
      !Array.isArray(page.files) || page.files.length !== before.changedFiles) {
    return hold("file_list_incomplete");
  }
  const current = new Set<string>();
  const base = new Set<string>();
  const head = new Set<string>();
  for (const file of page.files) {
    if (!file || !validPath(file.filename) || current.has(file.filename)) {
      return hold("file_list_invalid");
    }
    current.add(file.filename);
    if (file.status === "added") {
      if (file.previousFilename !== null) return hold("file_list_invalid");
      head.add(file.filename);
    } else if (file.status === "removed") {
      if (file.previousFilename !== null) return hold("file_list_invalid");
      if (base.has(file.filename)) return hold("file_list_invalid");
      base.add(file.filename);
    } else if (file.status === "modified" || file.status === "changed") {
      if (file.previousFilename !== null) return hold("file_list_invalid");
      if (base.has(file.filename)) return hold("file_list_invalid");
      base.add(file.filename);
      head.add(file.filename);
    } else if (file.status === "renamed") {
      if (!validPath(file.previousFilename) || file.previousFilename === file.filename) {
        return hold("file_list_invalid");
      }
      if (base.has(file.previousFilename)) return hold("file_list_invalid");
      base.add(file.previousFilename);
      head.add(file.filename);
    } else {
      // Unknown and copied statuses need an explicit side/path contract.
      return hold("file_status_unverified");
    }
  }
  const basePaths = [...base].sort();
  const headPaths = [...head].sort();
  return {
    status: "complete", repositoryId: before.repositoryId, number: before.number,
    baseSha: before.baseSha, headSha: before.headSha,
    mergeBaseSha,
    basePaths, headPaths,
  };
}

/** Side-aware membership must be checked before the older union-path proof. */
export function amuxPullRequestSourceInFileList(
  source: IdeaSourceFile,
  list: AmuxPullRequestFileListResult,
  expectedRepository: { fullName: string; id: number },
): boolean {
  return source?.kind === "pull_request_file" && list?.status === "complete" &&
    (source.side === "base" || source.side === "head") &&
    typeof source.repository === "string" && typeof expectedRepository?.fullName === "string" &&
    validId(expectedRepository.id) && list.repositoryId === expectedRepository.id &&
    source.repository.toLowerCase() === expectedRepository.fullName.toLowerCase() &&
    source.number === list.number && source.baseSha === list.baseSha &&
    source.headSha === list.headSha &&
    (source.side === "base" ? list.basePaths : list.headPaths).includes(source.path);
}
