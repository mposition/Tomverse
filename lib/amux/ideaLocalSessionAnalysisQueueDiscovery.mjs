import { amuxV4ApprovedAnalysisCliForModel,
  amuxV4CanClaimAnalysisCli } from "./ideaLocalApprovedCliCatalog.mjs";
import { pollAmuxV19SessionAnalysisCandidateIds,
  pollAmuxV19MaxSessionAnalysisCandidateIds } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";
import { readAmuxV19MaxPriceSelection } from
  "./ideaLocalMaxPriceSelectionRead.mjs";

const MAX_PAGES_PER_ATTEMPT = 8;

/** The Ubuntu worker's first content-free v19 step. It performs bounded
 * read-only queue discovery and selects an approved CLI tuple; it cannot claim a budget,
 * decrypt an idea, start a CLI, or publish a result. */
async function discoverCandidates(input, pollCandidates, admitted,
  unavailableKind, preflightField) {
  let after = input?.after ?? null;
  const seen = new Set(after === null ? [] : [after]);
  let hadCandidates = after !== null;
  let preflightUnavailable = false;
  for (let page = 0; page < MAX_PAGES_PER_ATTEMPT; page += 1) {
    const queue = await pollCandidates({ ...input, after });
    if (queue.kind !== "candidates") return { kind: queue.kind };
    hadCandidates ||= queue.candidates.length > 0;
    for (const candidate of queue.candidates) {
      const approved = amuxV4ApprovedAnalysisCliForModel(candidate.modelId);
      if (!amuxV4CanClaimAnalysisCli(approved, candidate.modelId)) continue;
      if (typeof input.preflightCandidate !== "function") {
        return { kind: "discovered", candidate };
      }
      const preflight = await input.preflightCandidate(candidate, approved);
      if (admitted(preflight)) {
        return { kind: "discovered", candidate,
          [preflightField]: preflight };
      }
      preflightUnavailable = true;
    }
    if (!queue.hasMore) return { kind: preflightUnavailable ? unavailableKind :
      hadCandidates ? "catalog_unapproved" : "idle" };
    if (seen.has(queue.nextCursor)) return { kind: "unavailable" };
    seen.add(queue.nextCursor);
    if (page === MAX_PAGES_PER_ATTEMPT - 1) {
      return { kind: "more_unexamined", after: queue.nextCursor };
    }
    after = queue.nextCursor;
  }
  return { kind: "unavailable" };
}

export async function discoverAmuxV19SessionAnalysisOnce(input) {
  return discoverCandidates(input, pollAmuxV19SessionAnalysisCandidateIds,
    (pin) => pin?.kind === "pinned" || pin?.kind === "no_references",
    "pin_unavailable", "pin");
}

/** Max discovery binds a queued model to the server's current approved price
 * before any claim or CLI call. It never receives the v4 Agent credential. */
export async function discoverAmuxV19MaxSessionAnalysisOnce(input) {
  return discoverCandidates({ ...input,
    preflightCandidate: async (candidate, approved) => {
      const price = await readAmuxV19MaxPriceSelection({
        origin: input.origin, reservationId: candidate.reservationId,
        ideaId: candidate.ideaId, fetchImpl: input.fetchImpl ?? fetch,
      });
      return price.kind === "ready" &&
        price.modelId === candidate.modelId &&
        price.reasoningEffort === approved.reasoningEffort
        ? price : { kind: "unavailable" };
    },
  }, pollAmuxV19MaxSessionAnalysisCandidateIds,
  (price) => price?.kind === "ready", "price_unavailable", "price");
}
