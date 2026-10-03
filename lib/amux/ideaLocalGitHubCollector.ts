import { inspectAmuxIdeaInput, type IdeaInput } from "./ideaInputCore.ts";
import { AMUX_V4_ANALYSIS_SOURCE_MAX_BYTES } from "./ideaAnalysisPromptCore.ts";
import { composeAmuxExternalTransferPromptCandidate } from
  "./ideaExternalTransferPromptCore.ts";
import { collectAmuxGitHubFileCandidate } from "./ideaGitHubFileCandidate.ts";
import type { AmuxIdeaGitHubRefAdapterConfig } from "./ideaGitHubRefReadAdapter.ts";
import { prepareAmuxGitHubExcerptPreview,
  type AmuxGitHubExcerptPreviewResult } from "./ideaGitHubExcerptPreviewCore.ts";
import { collectAmuxPullRequestFileCandidate } from "./ideaPullRequestFileCandidate.ts";
import {
  prepareAmuxScopedPullRequestExcerptPreview,
  prepareAmuxScopedRepositoryExcerptPreview,
} from "./ideaScopedExcerptPreviewCore.ts";
import { inspectAmuxIdeaSourceScope,
  type IdeaSourceScopeProposal } from "./ideaSourceScopeCore.ts";

type Credential = Omit<AmuxIdeaGitHubRefAdapterConfig, "signal">;
type SelectedRange = { sourceIndex: number; startByte: number; endByte: number };
type ScannedSources = Extract<AmuxGitHubExcerptPreviewResult,
  { status: "preview_candidate" }>["sources"];

export type AmuxLocalGitHubCollectionResult =
  | { status: "preview_candidate"; prompt: string; templateVersion: string;
      sourcePreviewDigest: string; selectedSourceIndices: readonly number[];
      unselectedSourceCount: number; canonicalScopeJson: string;
      sources: ScannedSources }
  | { status: "hold" | "reject"; reason: string };

const MAX_EXCERPTS = 12;
const REF_LIMITS = { maxPages: 3, maxRefs: 200,
  maxComparisons: 200, maxTagDepth: 4 } as const;

/**
 * Local Ubuntu collector only. `canonicalScopeJson` must come from a current
 * owner-approved scope after the app has authenticated its approval row and
 * digest. That proof is deliberately not inferred here from browser input.
 * Credentials stay in this process; the result contains only bounded,
 * scanned display candidates and never authorizes an external model call.
 * It is not an Admin receipt, DB approval or a live runner entrypoint.
 */
export async function collectAmuxLocalGitHubPreview(input: {
  previewId: string;
  declaredIdea: IdeaInput;
  canonicalScopeJson: string;
  repositoryCredentials: ReadonlyMap<string, Credential>;
  selections: readonly SelectedRange[];
  modelId: string;
  digestSecret: string;
}): Promise<AmuxLocalGitHubCollectionResult> {
  const hold = (reason: string): AmuxLocalGitHubCollectionResult =>
    ({ status: "hold", reason });
  const reject = (reason: string): AmuxLocalGitHubCollectionResult =>
    ({ status: "reject", reason });
  try {
    // Snapshot untrusted input once. A getter must not change the idea between
    // source binding, scanner input and the exact displayed model prompt.
    const checkedIdea = inspectAmuxIdeaInput(JSON.stringify(input.declaredIdea));
    if (!checkedIdea.ok) return hold("idea_unverified");
    const scope = inspectAmuxIdeaSourceScope(input.canonicalScopeJson,
      checkedIdea.input);
    if (!scope.ok || scope.canonicalJson !== input.canonicalScopeJson) {
      return hold("scope_unverified");
    }
    const canonical = JSON.parse(scope.canonicalJson) as IdeaSourceScopeProposal;
    if (!(input.repositoryCredentials instanceof Map) ||
        !Array.isArray(input.selections) || input.selections.length < 1 ||
        input.selections.length > MAX_EXCERPTS) return reject("invalid_excerpt_selection");
    const indices = new Set<number>();
    const selectedRepositories = new Set<string>();
    let selectedBytes = Buffer.byteLength(checkedIdea.input.idea, "utf8");
    for (const selection of input.selections) {
      if (!selection || !Number.isSafeInteger(selection.sourceIndex) ||
          selection.sourceIndex < 0 || selection.sourceIndex >= canonical.sources.length ||
          indices.has(selection.sourceIndex) ||
          !Number.isSafeInteger(selection.startByte) ||
          !Number.isSafeInteger(selection.endByte) ||
          selection.startByte < 0 || selection.endByte <= selection.startByte) {
        return reject("invalid_excerpt_selection");
      }
      indices.add(selection.sourceIndex);
      selectedRepositories.add(canonical.sources[selection.sourceIndex].repository.toLowerCase());
      selectedBytes += selection.endByte - selection.startByte;
      if (selectedBytes > AMUX_V4_ANALYSIS_SOURCE_MAX_BYTES) {
        return reject("chunk_input_too_large");
      }
    }
    if (input.repositoryCredentials.size !== selectedRepositories.size) {
      return hold("repository_identity_unverified");
    }
    for (const repository of selectedRepositories) {
      const credential = input.repositoryCredentials.get(repository);
      if (!credential || `${credential.owner}/${credential.repo}`.toLowerCase() !== repository ||
          !Number.isSafeInteger(credential.expectedRepositoryId) ||
          credential.expectedRepositoryId <= 0 ||
          typeof credential.token !== "string" || !credential.token.trim()) {
        return hold("repository_identity_unverified");
      }
    }
    const repositoryIds = new Map([...input.repositoryCredentials].map(([name, credential]) =>
      [name, credential.expectedRepositoryId]));
    const repositoryIdentities = new Map([...input.repositoryCredentials].map(([name, credential]) =>
      [name, { fullName: `${credential.owner}/${credential.repo}`,
        id: credential.expectedRepositoryId }]));
    const selected = [];
    const orderedSelections = [...input.selections].sort((left, right) =>
      left.sourceIndex - right.sourceIndex);
    const deadline = AbortSignal.timeout(60_000);
    for (const selection of orderedSelections) {
      if (deadline.aborted) return hold("collector_timeout");
      const source = canonical.sources[selection.sourceIndex];
      const credential = input.repositoryCredentials.get(source.repository.toLowerCase())!;
      const config = { ...credential, signal: deadline };
      if (source.kind === "repository_file") {
        const candidate = await collectAmuxGitHubFileCandidate(config,
          source.commitSha, source.path, REF_LIMITS);
        if (candidate.status !== "unscanned_candidate") {
          return { status: candidate.status, reason: candidate.reason };
        }
        const scoped = prepareAmuxScopedRepositoryExcerptPreview(
          checkedIdea.input, scope.canonicalJson, repositoryIds, input.modelId,
          [{ ...selection, candidate }], input.digestSecret);
        if (scoped.status !== "preview_candidate") return scoped;
        selected.push({ candidate, startByte: selection.startByte,
          endByte: selection.endByte });
      } else {
        const collected = await collectAmuxPullRequestFileCandidate(config,
          source, REF_LIMITS);
        if (collected.status !== "unscanned_pr_candidate") {
          return { status: collected.status, reason: collected.reason };
        }
        const scoped = prepareAmuxScopedPullRequestExcerptPreview(
          checkedIdea.input, scope.canonicalJson, repositoryIdentities,
          input.modelId, [{ ...selection, candidate: collected.candidate,
            fileList: collected.fileList }], input.digestSecret);
        if (scoped.status !== "preview_candidate") return scoped;
        selected.push({ candidate: collected.candidate,
          startByte: selection.startByte, endByte: selection.endByte });
      }
    }
    if (deadline.aborted) return hold("collector_timeout");
    const preview = prepareAmuxGitHubExcerptPreview(checkedIdea.input.idea,
      input.modelId, selected, input.digestSecret);
    const prompt = composeAmuxExternalTransferPromptCandidate(input.previewId,
      checkedIdea.input, preview);
    if (prompt.status !== "prompt_candidate") return prompt;
    return { status: "preview_candidate", prompt: prompt.prompt,
      templateVersion: prompt.templateVersion,
      sourcePreviewDigest: prompt.sourcePreviewDigest,
      selectedSourceIndices: orderedSelections.map((item) => item.sourceIndex),
      unselectedSourceCount: canonical.sources.length - indices.size,
      canonicalScopeJson: scope.canonicalJson,
      sources: prompt.sources };
  } catch {
    return hold("collector_unavailable");
  }
}
