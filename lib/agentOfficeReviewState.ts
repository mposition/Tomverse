/**
 * The independent review room's state, from the latest status report the
 * review server sent (lib/reviewOrchestratorStatusCore.ts).
 *
 * A reviewer the report calls disabled is off; one running a review is
 * reviewing; any other is idle. A report older than the reporter's five
 * missed beats makes every reviewer lost: the server, the network or the
 * reporter has stopped, and the last report says nothing about now.
 */

import type { AgentOfficeReviewState } from "@/lib/agentOffice/live";
import { REVIEW_ORCHESTRATOR_STALE_AFTER_MS, parseStoredReviewStatus } from "@/lib/reviewOrchestratorStatusCore";

export function agentOfficeReviewState(input: { stored: string | null; now: Date }): AgentOfficeReviewState {
  if (input.stored === null) return { kind: "not_reporting" };
  const parsed = parseStoredReviewStatus(input.stored);
  if (parsed.state === "unreadable") return { kind: "unreadable" };
  const age = input.now.getTime() - Date.parse(parsed.receivedAt);
  const stale = age > REVIEW_ORCHESTRATOR_STALE_AFTER_MS;
  const { snapshot } = parsed;
  return {
    kind: "observed",
    receivedAt: parsed.receivedAt,
    stale,
    draining: snapshot.draining,
    pendingJobs: snapshot.pendingJobs,
    reviewers: snapshot.providers.map((provider) => ({
      id: provider.id,
      vendor: provider.vendor,
      state: stale ? "lost" : !provider.enabled ? "off" : provider.running > 0 ? "reviewing" : "idle",
      running: provider.running,
      maxConcurrent: provider.maxConcurrent,
      quota: provider.quota ?? null,
    })),
    last24h: snapshot.last24h,
  };
}
