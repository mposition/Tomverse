/**
 * What a person needs beside an owner queue item to decide it
 * (docs/policy/engineering-agent.md §11): which card and run it is about, which
 * pull request it touches, what the patch changes, and who reviewed it. Pure:
 * the console read gathers the rows, this shapes them.
 */

import { ENGINEERING_AGENT_V22_TIER_PENDING_REASON } from "@/lib/engineeringAgentCore";

/**
 * Whether a person may send a T2 draft back to the publisher's next tier round
 * (POST /api/admin/engineering-agent/rejudge): a v22 draft with its patch kept,
 * not still waiting on its first tier round, from a v4 idea card whose run
 * started in T1 on an AMUX attempt. The engineering console and the owner queue
 * card both offer the button from this one rule; the route decides again.
 */
export const engineeringAgentDraftRejudgeable = (
  item: { kind: string; patchBody: string | null; reason: string | null },
  run: { modeAtStart: string; amuxAttemptId: string | null; card: { sourceSystem: string | null } } | null,
): boolean =>
  item.kind === "t2_draft" && item.patchBody !== null &&
  item.reason !== ENGINEERING_AGENT_V22_TIER_PENDING_REASON &&
  run?.card.sourceSystem === "admin-idea-v4" &&
  run.modeAtStart === "t1" && !!run.amuxAttemptId;

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

/**
 * An open engineering item shown on an AMUX owner queue card, so the owner
 * decides it on the card instead of in Admin › Engineering › Decisions: a T2
 * draft (approve, reject, judge again) or a state mismatch (a `review_pr:` one
 * can record the bound pull request on the card). The buttons post to the
 * engineering routes, which check permission, the digest and the lock again.
 */
export type EngineeringAgentCardItemView = {
  id: string;
  kind: "t2_draft" | "state_mismatch";
  reason: string | null;
  causeKey: string;
  createdAt: string;
  /** A draft's patch, shown as text; null for a mismatch. */
  patchBody: string | null;
  patchDigest: string | null;
  baseSha: string | null;
  rejudgeable: boolean;
  /** The draft's changed files, at most ENGINEERING_AGENT_PATCH_FILE_LIMIT; `fileCount` is all of them. */
  files: EngineeringAgentPatchFile[];
  fileCount: number;
};

/** The kinds a card shows; a `decision` item is only acknowledged, in the engineering console. */
export const ENGINEERING_AGENT_CARD_ITEM_KINDS = ["t2_draft", "state_mismatch"] as const;

type CardItemRun = { cardId: string; modeAtStart: string; amuxAttemptId: string | null; card: { sourceSystem: string | null } };

export type EngineeringAgentCardItemRow = {
  id: string;
  kind: string;
  state?: string;
  reason: string | null;
  causeKey: string;
  createdAt: Date;
  patchBody: string | null;
  patchDigest: string | null;
  baseSha: string | null;
  run: CardItemRun | null;
};

/**
 * The open items of each card, oldest first, keyed by card id. An item's card
 * is its run's; a `review_pr:` mismatch has no run of its own, and its card is
 * the run of the published item it names (`publishRuns`, keyed by that id).
 * Items of other cards, settled items and other kinds are left out.
 */
export function engineeringAgentCardItems(
  cardIds: readonly string[],
  rows: readonly EngineeringAgentCardItemRow[],
  publishRuns: ReadonlyMap<string, CardItemRun | null>,
): Map<string, EngineeringAgentCardItemView[]> {
  const wanted = new Set(cardIds);
  const byCard = new Map<string, EngineeringAgentCardItemView[]>();
  const seen = new Set<string>();
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  for (const row of sorted) {
    if (seen.has(row.id) || (row.state !== undefined && row.state !== "open")) continue;
    if (!(ENGINEERING_AGENT_CARD_ITEM_KINDS as readonly string[]).includes(row.kind)) continue;
    const publishId = row.run === null ? engineeringAgentMismatchPublishItemId(row.causeKey) : null;
    const cardId = row.run?.cardId ?? (publishId === null ? null : publishRuns.get(publishId)?.cardId ?? null);
    if (cardId === null || !wanted.has(cardId)) continue;
    seen.add(row.id);
    const draft = row.kind === "t2_draft";
    const files = draft && row.patchBody !== null ? engineeringAgentPatchFiles(row.patchBody) : [];
    const list = byCard.get(cardId) ?? [];
    list.push({
      id: row.id,
      kind: row.kind as EngineeringAgentCardItemView["kind"],
      reason: row.reason,
      causeKey: row.causeKey,
      createdAt: row.createdAt.toISOString(),
      patchBody: draft ? row.patchBody : null,
      patchDigest: row.patchDigest,
      baseSha: row.baseSha,
      rejudgeable: engineeringAgentDraftRejudgeable(row, row.run),
      files: files.slice(0, ENGINEERING_AGENT_PATCH_FILE_LIMIT),
      fileCount: files.length,
    });
    byCard.set(cardId, list);
  }
  return byCard;
}
