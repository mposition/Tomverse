import type { AiReviewEvalCase, AiReviewEvalDataset } from "./aiReviewEvalCore";

export type AiReviewPreparationSet = {
  file: string;
  digest: string;
  dataset: AiReviewEvalDataset;
  shortfalls: readonly string[];
  structuralProblems: readonly string[];
};
export type AiReviewPreparationCatalog = {
  sets: AiReviewPreparationSet[];
  problems: string[];
};

/** A downloadable proposal never carries adoption or freeze authority forward. */
export function aiReviewCandidateProposal(
  set: AiReviewPreparationSet,
  item: AiReviewEvalCase,
  edits: Pick<AiReviewEvalCase, "question" | "responses" | "notes">,
) {
  if (!set.dataset.cases.some((source) => source.id === item.id))
    throw new Error("The candidate does not belong to this dataset.");
  return {
    kind: "ai-review-candidate-proposal",
    sourceDatasetDigest: set.digest,
    sourceDatasetVersion: set.dataset.version,
    decision: "pending",
    proposedCase: {
      ...item,
      ...edits,
      status: "candidate",
      adoptedBy: null,
      adoptedAt: null,
    },
  };
}

export function aiReviewSampleProposal(
  set: AiReviewPreparationSet,
  ids: readonly string[],
  version: string,
) {
  if (!version.trim() || version.trim() === set.dataset.version)
    throw new Error("Name a new dataset version.");
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error("Select a nonempty, unique set of cases.");
  const selected = new Set(ids);
  const cases = set.dataset.cases.filter((item) => selected.has(item.id));
  if (cases.length !== selected.size) throw new Error("Unknown case selected.");
  return {
    sourceDatasetDigest: set.digest,
    decision: "pending",
    dataset: {
      ...set.dataset,
      version: version.trim(),
      purpose: "decision",
      frozenAt: null,
      frozenBy: null,
      frozenDigest: null,
      cases: cases.map((item) => ({
        ...item,
        status: "candidate",
        adoptedBy: null,
        adoptedAt: null,
      })),
    },
  };
}
