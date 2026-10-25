/**
 * What the QA and release tab puts in front of the operator: the items that
 * need a person, most urgent first, and the four figures the tab opens with.
 * Pure: it reads what the page already loaded (the digest console, the main
 * candidates and the train reports) and adds no new source. Nothing here
 * decides a release; it only orders what is already recorded.
 */
import type { AgentDigestConsole, AgentDigestConsoleRow } from "@/lib/agentDigestConsoleRead";
import type { QaReleaseMainCandidates } from "@/lib/qaReleaseMainCandidatesCore";

export type QaReleaseAttentionItem =
  | { kind: "lane_latched"; reason: string | null; pullRequestNumber: number | null }
  | { kind: "control_missing" }
  | { kind: "production_behind"; servingSha: string | null; mainHeadSha: string | null }
  | { kind: "main_refused"; numbers: number[] }
  | { kind: "main_unread"; failure: string | null }
  | { kind: "ci_failed"; count: number }
  | { kind: "checks_failed"; count: number }
  | { kind: "digest_stale"; lastAt: string | null }
  | { kind: "train_failed"; slot: string; failure: string | null };

export type QaReleaseTrainOutcome = { slot: string; at: string; outcome: "opened" | "empty" | "failed"; failure: string | null };

/** A digest is daily; one older than this means the digest service stopped. */
export const QA_RELEASE_DIGEST_STALE_MS = 36 * 60 * 60 * 1000;

/** The newest digest whose body could be read, or null. */
export const latestReadableDigest = (digests: readonly AgentDigestConsoleRow[]) =>
  digests.find((row) => row.summary !== null) ?? null;

export function qaReleaseAttentionItems(input: {
  console: Pick<AgentDigestConsole, "control" | "digests" | "mergeLane">;
  main: QaReleaseMainCandidates;
  /** Newest first. */
  trains: readonly QaReleaseTrainOutcome[];
  nowMs: number;
}): QaReleaseAttentionItem[] {
  const { control, digests, mergeLane } = input.console;
  const items: QaReleaseAttentionItem[] = [];

  if (mergeLane.latched) {
    const attempt = mergeLane.latchAttempt ?? mergeLane.openAttempt;
    items.push({ kind: "lane_latched", reason: mergeLane.latch?.reason ?? null, pullRequestNumber: attempt?.pullRequestNumber ?? null });
  }
  if (control === null) items.push({ kind: "control_missing" });

  const { production, pullRequests } = input.main;
  if (production.servesMainHead === false) {
    items.push({ kind: "production_behind", servingSha: production.servingSha, mainHeadSha: production.mainHeadSha });
  }
  if (pullRequests === null) items.push({ kind: "main_unread", failure: input.main.readFailure ?? null });
  else {
    const refused = pullRequests.filter((pull) => !pull.allowed).map((pull) => pull.number);
    if (refused.length > 0) items.push({ kind: "main_refused", numbers: refused });
  }

  const latest = latestReadableDigest(digests);
  if (latest?.summary) {
    if (latest.summary.failedCiJobs > 0) items.push({ kind: "ci_failed", count: latest.summary.failedCiJobs });
    if (latest.summary.failedChecks > 0) items.push({ kind: "checks_failed", count: latest.summary.failedChecks });
  }
  // Only while the digest is meant to run: a switched-off digest is not late.
  if (control?.digestEnabled) {
    const newest = digests[0]?.createdAt ?? null;
    if (newest === null || input.nowMs - Date.parse(newest) > QA_RELEASE_DIGEST_STALE_MS) {
      items.push({ kind: "digest_stale", lastAt: newest });
    }
  }

  const train = input.trains[0];
  if (train?.outcome === "failed") items.push({ kind: "train_failed", slot: train.slot, failure: train.failure });

  return items;
}

export type QaReleaseStatusFigures = {
  production: "serves_main" | "behind" | "unknown";
  servingSha: string | null;
  mainHeadSha: string | null;
  /** null when GitHub could not be read. */
  mainPulls: { total: number; drafts: number } | null;
  /** From the newest readable digest; null when there is none. */
  gates: { evidence: number; total: number; byVerdict: Record<string, number> } | null;
  latency: { merges: number; median: number | null; max: number | null } | null;
};

export function qaReleaseStatusFigures(input: {
  digests: readonly AgentDigestConsoleRow[];
  main: QaReleaseMainCandidates;
}): QaReleaseStatusFigures {
  const { production, pullRequests } = input.main;
  const summary = latestReadableDigest(input.digests)?.summary ?? null;
  const byVerdict = summary?.gatesByVerdict ?? null;
  const total = byVerdict ? Object.values(byVerdict).reduce((sum, count) => sum + count, 0) : 0;
  return {
    production: production.servesMainHead === null ? "unknown" : production.servesMainHead ? "serves_main" : "behind",
    servingSha: production.servingSha,
    mainHeadSha: production.mainHeadSha,
    mainPulls: pullRequests === null ? null : { total: pullRequests.length, drafts: pullRequests.filter((pull) => pull.draft).length },
    gates: byVerdict ? { evidence: byVerdict.evidence_present ?? 0, total, byVerdict } : null,
    latency:
      summary?.latency.status === "ok"
        ? { merges: summary.latency.merges, median: summary.latency.medianDevDeployedMin, max: summary.latency.maxDevDeployedMin }
        : null,
  };
}
