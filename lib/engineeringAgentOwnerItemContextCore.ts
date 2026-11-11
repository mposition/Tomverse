/**
 * What a person needs beside an owner queue item to decide it
 * (docs/policy/engineering-agent.md §11): which card and run it is about, which
 * pull request it touches, what the patch changes, and who reviewed it. Pure:
 * the console read gathers the rows, this shapes them.
 */

/** A mismatch about a published item names that item in its cause key. */
export const ENGINEERING_AGENT_REVIEW_PR_CAUSE_PREFIX = "review_pr:";

export const engineeringAgentMismatchPublishItemId = (causeKey: string): string | null =>
  causeKey.startsWith(ENGINEERING_AGENT_REVIEW_PR_CAUSE_PREFIX)
    ? causeKey.slice(ENGINEERING_AGENT_REVIEW_PR_CAUSE_PREFIX.length) || null
    : null;

export type EngineeringAgentPatchFile = { path: string; added: number; removed: number };

/** The most files a card lists; the count beside it says how many there are. */
export const ENGINEERING_AGENT_PATCH_FILE_LIMIT = 50;

/**
 * The files a unified diff changes, with added and removed line counts, in
 * patch order. Counting only: the text is never applied or interpreted.
 */
export function engineeringAgentPatchFiles(patch: string): EngineeringAgentPatchFile[] {
  const files: EngineeringAgentPatchFile[] = [];
  let current: EngineeringAgentPatchFile | null = null;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.replace(/\r$/, ""));
    if (header) {
      current = { path: header[2]!, added: 0, removed: 0 };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
  }
  return files;
}

type ObservedBinding = {
  prNumber: number;
  state: string;
  supersededAt: Date | null;
  approvalObservation: unknown;
  mergeObservation: unknown;
};

const field = (value: unknown, key: string) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;

export type EngineeringAgentItemPullRequest = {
  prNumber: number;
  state: string;
  current: boolean;
  approvalVerdict: string | null;
  merged: boolean | null;
};

export const engineeringAgentItemPullRequest = (row: ObservedBinding): EngineeringAgentItemPullRequest => {
  const verdict = field(row.approvalObservation, "verdict");
  const merged = field(row.mergeObservation, "merged");
  return {
    prNumber: row.prNumber,
    state: row.state,
    current: row.supersededAt === null,
    approvalVerdict: typeof verdict === "string" ? verdict : null,
    merged: typeof merged === "boolean" ? merged : null,
  };
};
