import type { IdeaSourceFile } from "./ideaSourceScopeCore.ts";
import {
  amuxPullRequestSourceInFileList,
  type AmuxPullRequestFileListResult,
} from "./ideaPullRequestFileListCore.ts";
import {
  collectAmuxIdeaPullRequestFileList,
  type AmuxIdeaPullRequestReaderConfig,
} from "./ideaPullRequestFileListAdapter.ts";
import {
  collectAmuxGitHubFileCandidate,
  type AmuxGitHubFileCandidateResult,
} from "./ideaGitHubFileCandidate.ts";
import type { AmuxOwnedRefSearchLimits } from "./ideaOwnedRefSearchCore.ts";

type CompleteList = Extract<AmuxPullRequestFileListResult, { status: "complete" }>;
type Candidate = Extract<AmuxGitHubFileCandidateResult, { status: "unscanned_candidate" }>;

export type AmuxPullRequestFileCandidateResult =
  | { status: "unscanned_pr_candidate"; fileList: CompleteList; candidate: Candidate }
  | { status: "hold" | "reject"; reason: string };

const samePaths = (a: readonly string[], b: readonly string[]): boolean =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
  a.every((path, index) => path === b[index]);
const sameList = (a: CompleteList, b: CompleteList): boolean =>
  a.repositoryId === b.repositoryId && a.number === b.number &&
  a.baseSha === b.baseSha && a.headSha === b.headSha &&
  a.mergeBaseSha === b.mergeBaseSha &&
  samePaths(a.basePaths, b.basePaths) && samePaths(a.headPaths, b.headPaths);

/**
 * Pure final check after list → exact file candidate → list. It cannot prove
 * the provenance of caller-provided objects; only the credential-isolated
 * collector may use its accepted result. The full sequence repeats before
 * any owner-approved external send, never merely this pure check.
 */
export function inspectAmuxPullRequestFileCandidateCollection(
  source: IdeaSourceFile,
  expectedRepository: { fullName: string; id: number },
  first: AmuxPullRequestFileListResult,
  candidate: AmuxGitHubFileCandidateResult,
  last: AmuxPullRequestFileListResult,
): AmuxPullRequestFileCandidateResult {
  const hold = (reason: string): AmuxPullRequestFileCandidateResult => ({ status: "hold", reason });
  if (source?.kind !== "pull_request_file" || !expectedRepository ||
      typeof expectedRepository.fullName !== "string" ||
      !Number.isSafeInteger(expectedRepository.id) || expectedRepository.id <= 0 ||
      first?.status !== "complete" || last?.status !== "complete" ||
      first.repositoryId !== expectedRepository.id ||
      last.repositoryId !== expectedRepository.id ||
      !Array.isArray(first.basePaths) || !Array.isArray(first.headPaths) ||
      !Array.isArray(last.basePaths) || !Array.isArray(last.headPaths) ||
      !sameList(first, last) ||
      !amuxPullRequestSourceInFileList(source, first, expectedRepository) ||
      !amuxPullRequestSourceInFileList(source, last, expectedRepository)) {
    return hold("pr_collection_changed");
  }
  if (first.mergeBaseSha !== first.baseSha) return hold("pr_base_not_merge_base");
  if (candidate?.status === "hold" || candidate?.status === "reject") {
    return { status: candidate.status, reason: candidate.reason };
  }
  const targetSha = source.side === "base" ? source.baseSha : source.headSha;
  if (candidate?.status !== "unscanned_candidate" ||
      candidate.file?.repositoryId !== first.repositoryId ||
      candidate.witness?.repositoryId !== first.repositoryId ||
      candidate.file.commitSha !== targetSha || candidate.file.path !== source.path) {
    return hold("pr_file_candidate_mismatch");
  }
  return { status: "unscanned_pr_candidate", fileList: first, candidate };
}

/**
 * Dark collector-only composition. Its token and file text must never enter
 * the model CLI. This returns an unscanned candidate, not a display preview
 * or external-transfer authorization.
 */
export async function collectAmuxPullRequestFileCandidate(
  config: AmuxIdeaPullRequestReaderConfig,
  source: IdeaSourceFile,
  limits: AmuxOwnedRefSearchLimits,
): Promise<AmuxPullRequestFileCandidateResult> {
  if (!config || source?.kind !== "pull_request_file" ||
      typeof config.owner !== "string" || typeof config.repo !== "string" ||
      !Number.isSafeInteger(config.expectedRepositoryId) || config.expectedRepositoryId <= 0 ||
      typeof source.repository !== "string" || typeof source.path !== "string" ||
      !Number.isSafeInteger(source.number) || source.number <= 0 ||
      (source.side !== "base" && source.side !== "head") ||
      source.repository.toLowerCase() !== `${config.owner}/${config.repo}`.toLowerCase()) {
    return { status: "hold", reason: "pr_source_unverified" };
  }
  try {
    // Provisional collector bound. Live enablement requires an independently
    // enforced service hard deadline longer than this and measured S0 timing.
    const outerSignal = config.signal
      ? AbortSignal.any([config.signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000);
    const boundedConfig = { ...config, signal: outerSignal };
    const expectedRepository = {
      fullName: `${config.owner}/${config.repo}`, id: config.expectedRepositoryId,
    };
    const first = await collectAmuxIdeaPullRequestFileList(boundedConfig, source.number);
    if (first.status === "hold") return { status: "hold", reason: first.reason };
    if (!amuxPullRequestSourceInFileList(source, first, expectedRepository) ||
        first.repositoryId !== expectedRepository.id) {
      return { status: "hold", reason: "pr_source_unverified" };
    }
    // Deliberate conservative scope: base tip must equal three-dot merge-base.
    // S0 measures how often this excludes otherwise usable PRs.
    if (first.mergeBaseSha !== first.baseSha) {
      return { status: "hold", reason: "pr_base_not_merge_base" };
    }
    const targetSha = source.side === "base" ? source.baseSha : source.headSha;
    const candidate = await collectAmuxGitHubFileCandidate(
      boundedConfig, targetSha, source.path, limits,
    );
    if (candidate.status !== "unscanned_candidate") {
      return { status: candidate.status, reason: candidate.reason };
    }
    const last = await collectAmuxIdeaPullRequestFileList(boundedConfig, source.number);
    return inspectAmuxPullRequestFileCandidateCollection(
      source, expectedRepository, first, candidate, last,
    );
  } catch {
    // Collection is read-only; an unexpected abort/throw is an unknown proof,
    // never a reason to retry blindly or return an unverified candidate.
    return { status: "hold", reason: "pr_collection_unverified" };
  }
}
