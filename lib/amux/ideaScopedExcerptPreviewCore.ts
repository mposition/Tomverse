import { inspectAmuxIdeaInput, type IdeaInput } from "./ideaInputCore.ts";
import type { AmuxGitHubFileCandidateResult } from "./ideaGitHubFileCandidate.ts";
import {
  prepareAmuxGitHubExcerptPreview,
  type AmuxGitHubExcerptPreviewResult,
} from "./ideaGitHubExcerptPreviewCore.ts";
import { inspectAmuxIdeaSourceScope, type IdeaSourceScopeProposal } from "./ideaSourceScopeCore.ts";

type Candidate = Extract<AmuxGitHubFileCandidateResult, { status: "unscanned_candidate" }>;

export type AmuxScopedExcerptSelection = {
  /** Index in the canonical, sorted source scope shown to the owner. */
  sourceIndex: number;
  candidate: Candidate;
  startByte: number;
  endByte: number;
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
