import { inspectAmuxIdeaInput, type IdeaInput } from "./ideaInputCore.ts";
import type { AmuxGitHubFileCandidateResult } from "./ideaGitHubFileCandidate.ts";
import {
  prepareAmuxGitHubExcerptPreview,
  type AmuxGitHubExcerptPreviewResult,
} from "./ideaGitHubExcerptPreviewCore.ts";
import { inspectAmuxIdeaSourceScope, type IdeaSourceScopeProposal } from "./ideaSourceScopeCore.ts";
import {
  amuxPullRequestSourceInFileList,
  type AmuxPullRequestFileListResult,
} from "./ideaPullRequestFileListCore.ts";

type Candidate = Extract<AmuxGitHubFileCandidateResult, { status: "unscanned_candidate" }>;

export type AmuxScopedExcerptSelection = {
  /** Index in the canonical, sorted source scope shown to the owner. */
  sourceIndex: number;
  candidate: Candidate;
  startByte: number;
  endByte: number;
};

export type AmuxScopedPullRequestExcerptSelection = AmuxScopedExcerptSelection & {
  /** Complete, side-aware witness from the credential-isolated collector. */
  fileList: AmuxPullRequestFileListResult;
};

/**
 * A consistency guard between declared scope and collector results. The map
 * of numeric repository IDs must come from the credential-isolated collector,
 * never the browser or model. Neither this function nor its preview is an
 * authorization to send bytes. Current dark collector supports repository
 * files only; PR files hold until a complete changed-file witness exists.
 */
export function prepareAmuxScopedRepositoryExcerptPreview(
  declared: IdeaInput,
  scopeJson: string,
  repositoryIds: ReadonlyMap<string, number>,
  model: string,
  selections: readonly AmuxScopedExcerptSelection[],
  digestSecret: string,
): AmuxGitHubExcerptPreviewResult {
  const hold = (reason: string): AmuxGitHubExcerptPreviewResult => ({ status: "hold", reason });
  if (!declared || typeof declared !== "object" || typeof scopeJson !== "string") {
    return hold("idea_unverified");
  }
  if (!(repositoryIds instanceof Map) || !Array.isArray(selections)) return hold("collector_unverified");
  let checkedIdea;
  try {
    checkedIdea = inspectAmuxIdeaInput(JSON.stringify(declared));
  } catch {
    return hold("idea_unverified");
  }
  if (!checkedIdea.ok) return hold("idea_unverified");
  const inspected = inspectAmuxIdeaSourceScope(scopeJson, checkedIdea.input);
  if (!inspected.ok) return hold("scope_unverified");
  const scope = JSON.parse(inspected.canonicalJson) as IdeaSourceScopeProposal;
  const bound: Array<{ candidate: Candidate; startByte: number; endByte: number }> = [];
  for (const selected of selections) {
    if (!selected || !Number.isSafeInteger(selected.sourceIndex) ||
        selected.sourceIndex < 0 || selected.sourceIndex >= scope.sources.length) {
      return hold("scope_selection_unverified");
    }
    const source = scope.sources[selected.sourceIndex];
    if (source.kind !== "repository_file") return hold("pr_collection_unavailable");
    const expectedId = repositoryIds.get(source.repository.toLowerCase());
    const candidate = selected.candidate;
    if (!Number.isSafeInteger(expectedId) || (expectedId ?? 0) <= 0 ||
        candidate?.status !== "unscanned_candidate" ||
        candidate.file?.repositoryId !== expectedId ||
        candidate.witness?.repositoryId !== expectedId ||
        candidate.file.commitSha !== source.commitSha || candidate.file.path !== source.path) {
      return hold("source_scope_mismatch");
    }
    bound.push({ candidate, startByte: selected.startByte, endByte: selected.endByte });
  }
  return prepareAmuxGitHubExcerptPreview(checkedIdea.input.idea, model, bound, digestSecret);
}

/**
 * PR counterpart of the repository-file guard. The caller owns the read-only
 * collector and must supply its repository identity, file-list witness and
 * candidate from one bounded collection cycle, not browser/model claims.
 * This makes a display-only preview; it never approves source transfer and
 * the complete collection must be repeated before the send.
 */
export function prepareAmuxScopedPullRequestExcerptPreview(
  declared: IdeaInput,
  scopeJson: string,
  repositoryIdentities: ReadonlyMap<string, { fullName: string; id: number }>,
  model: string,
  selections: readonly AmuxScopedPullRequestExcerptSelection[],
  digestSecret: string,
): AmuxGitHubExcerptPreviewResult {
  const hold = (reason: string): AmuxGitHubExcerptPreviewResult => ({ status: "hold", reason });
  if (!declared || typeof declared !== "object" || typeof scopeJson !== "string") {
    return hold("idea_unverified");
  }
  if (!(repositoryIdentities instanceof Map) || !Array.isArray(selections)) {
    return hold("collector_unverified");
  }
  let checkedIdea;
  try {
    checkedIdea = inspectAmuxIdeaInput(JSON.stringify(declared));
  } catch {
    return hold("idea_unverified");
  }
  if (!checkedIdea.ok) return hold("idea_unverified");
  const inspected = inspectAmuxIdeaSourceScope(scopeJson, checkedIdea.input);
  if (!inspected.ok) return hold("scope_unverified");
  const scope = JSON.parse(inspected.canonicalJson) as IdeaSourceScopeProposal;
  const bound: Array<{ candidate: Candidate; startByte: number; endByte: number }> = [];
  for (const selected of selections) {
    if (!selected || !Number.isSafeInteger(selected.sourceIndex) ||
        selected.sourceIndex < 0 || selected.sourceIndex >= scope.sources.length) {
      return hold("scope_selection_unverified");
    }
    const source = scope.sources[selected.sourceIndex];
    if (source.kind !== "pull_request_file") return hold("not_pr_source");
    const identity = repositoryIdentities.get(source.repository.toLowerCase());
    const candidate = selected.candidate;
    const selectedSha = source.side === "base" ? source.baseSha : source.headSha;
    // The PR files page is merge-base/head. A moved base intentionally holds
    // both sides here; never label its current bytes as three-dot base.
    if (!identity || !Number.isSafeInteger(identity.id) || identity.id <= 0 ||
        typeof identity.fullName !== "string" ||
        selected.fileList?.status !== "complete" ||
        selected.fileList.mergeBaseSha !== source.baseSha ||
        !amuxPullRequestSourceInFileList(source, selected.fileList, identity) ||
        candidate?.status !== "unscanned_candidate" ||
        candidate.file?.repositoryId !== identity.id ||
        candidate.witness?.repositoryId !== identity.id ||
        candidate.file.commitSha !== selectedSha || candidate.file.path !== source.path) {
      return hold("pr_source_scope_mismatch");
    }
    bound.push({ candidate, startByte: selected.startByte, endByte: selected.endByte });
  }
  return prepareAmuxGitHubExcerptPreview(checkedIdea.input.idea, model, bound, digestSecret);
}
