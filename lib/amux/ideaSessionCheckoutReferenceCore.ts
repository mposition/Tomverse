import type { IdeaInput } from "./ideaInputCore.ts";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export type AmuxSessionCheckoutReference = {
  referenceCount: number;
  kind: "repository" | "pull_request";
  repository: string;
  pullRequestNumber: number | null;
  pinnedCommitSha: string;
};

/** Derive one checkout target from the sealed intake input and its canonical
 * audit pins. Queue hints and caller-provided repository names have no role. */
export function selectAmuxSessionCheckoutReference(input: {
  idea: IdeaInput;
  referenceCount: number;
  pinnedCommitSha: string | null;
  referenceOrdinal: number;
}): AmuxSessionCheckoutReference | null {
  const { idea, referenceCount, pinnedCommitSha, referenceOrdinal } = input;
  if (!Number.isSafeInteger(referenceOrdinal) || referenceOrdinal < 0 ||
      !Array.isArray(idea.repositories) || !Array.isArray(idea.pullRequests) ||
      referenceCount !== idea.repositories.length + idea.pullRequests.length ||
      referenceOrdinal >= referenceCount ||
      typeof pinnedCommitSha !== "string" || !SHA.test(pinnedCommitSha)) {
    return null;
  }
  if (referenceOrdinal < idea.repositories.length) {
    return { referenceCount, kind: "repository",
      repository: idea.repositories[referenceOrdinal]!, pullRequestNumber: null,
      pinnedCommitSha };
  }
  const pull = idea.pullRequests[referenceOrdinal - idea.repositories.length]!;
  return { referenceCount, kind: "pull_request",
    repository: pull.repository, pullRequestNumber: pull.number,
    pinnedCommitSha };
}
