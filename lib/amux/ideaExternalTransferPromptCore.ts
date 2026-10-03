import { inspectAmuxIdeaInput, type IdeaInput } from "./ideaInputCore.ts";
import type { AmuxGitHubExcerptPreviewResult } from "./ideaGitHubExcerptPreviewCore.ts";
import type { AmuxScopedExcerptSelection,
  AmuxScopedPullRequestExcerptSelection } from "./ideaScopedExcerptPreviewCore.ts";
import {
  prepareAmuxScopedPullRequestExcerptPreview,
  prepareAmuxScopedRepositoryExcerptPreview,
} from "./ideaScopedExcerptPreviewCore.ts";
import {
  buildAmuxIdeaAnalysisPrompt,
  type AmuxIdeaAnalysisPromptResult,
} from "./ideaAnalysisPromptCore.ts";

type PreviewCandidate = Extract<AmuxGitHubExcerptPreviewResult,
  { status: "preview_candidate" }>;

export type AmuxExternalTransferPromptCandidate =
  | { status: "prompt_candidate"; prompt: string; templateVersion: string;
      sourcePreviewDigest: string; sources: PreviewCandidate["sources"] }
  | { status: "hold" | "reject"; reason: string };

/**
 * Compose the exact first-chunk model input from collector-verified source
 * bytes. This is a display candidate only: caller provenance, owner approval,
 * current source, encrypted storage and one-time send authorization remain
 * separate checks. A source-scope approval alone must never call this a send.
 * The caller must use the same normalized idea snapshot that produced the
 * scanned excerpt candidate; this function does not authenticate provenance.
 */
export function composeAmuxExternalTransferPromptCandidate(previewId: string,
  idea: IdeaInput,
  excerpt: AmuxGitHubExcerptPreviewResult): AmuxExternalTransferPromptCandidate {
  if (excerpt.status !== "preview_candidate") return excerpt;
  const sourceTexts = [
    { refId: "operator_idea", kind: "operator_idea" as const, text: idea.idea },
    ...excerpt.sources.map((source, index) => ({
      refId: `github_excerpt_${index + 1}`,
      kind: "github_excerpt" as const,
      text: source.excerptText,
    })),
  ];
  const result: AmuxIdeaAnalysisPromptResult = buildAmuxIdeaAnalysisPrompt({
    previewId, chunkIndex: 0, revisionChunkIndex: 0,
    continuation: null, sourceTexts, permittedTargetRefs: [],
  });
  if (result.status !== "prompt_candidate") return result;
  return { status: "prompt_candidate", prompt: result.prompt,
    templateVersion: result.version, sourcePreviewDigest: excerpt.previewDigest,
    sources: excerpt.sources };
}

function snapshotIdea(idea: IdeaInput): IdeaInput | null {
  try {
    const inspected = inspectAmuxIdeaInput(JSON.stringify(idea));
    return inspected.ok ? inspected.input : null;
  } catch {
    return null;
  }
}

export function buildAmuxScopedRepositoryTransferPromptCandidate(input: {
  previewId: string; idea: IdeaInput; scopeJson: string;
  repositoryIds: ReadonlyMap<string, number>; modelId: string;
  selections: readonly AmuxScopedExcerptSelection[]; digestSecret: string;
}): AmuxExternalTransferPromptCandidate {
  const idea = snapshotIdea(input.idea);
  if (!idea) return { status: "hold", reason: "idea_unverified" };
  return composeAmuxExternalTransferPromptCandidate(input.previewId, idea,
    prepareAmuxScopedRepositoryExcerptPreview(idea, input.scopeJson,
      input.repositoryIds, input.modelId, input.selections, input.digestSecret));
}

export function buildAmuxScopedPullRequestTransferPromptCandidate(input: {
  previewId: string; idea: IdeaInput; scopeJson: string;
  repositoryIdentities: ReadonlyMap<string, { fullName: string; id: number }>;
  modelId: string; selections: readonly AmuxScopedPullRequestExcerptSelection[];
  digestSecret: string;
}): AmuxExternalTransferPromptCandidate {
  const idea = snapshotIdea(input.idea);
  if (!idea) return { status: "hold", reason: "idea_unverified" };
  return composeAmuxExternalTransferPromptCandidate(input.previewId, idea,
    prepareAmuxScopedPullRequestExcerptPreview(idea, input.scopeJson,
      input.repositoryIdentities, input.modelId, input.selections, input.digestSecret));
}
