import { amuxV4ApprovedAnalysisCliForModel,
  amuxV4CanClaimAnalysisCli } from "./ideaLocalApprovedCliCatalog.mjs";
import { pollAmuxV19SessionAnalysisCandidateIds } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";

const MAX_PAGES_PER_ATTEMPT = 8;

/** The Ubuntu worker's first content-free v19 step. It performs bounded
 * read-only queue discovery and selects an approved CLI tuple; it cannot claim a budget,
 * decrypt an idea, start a CLI, or publish a result. */
export async function discoverAmuxV19SessionAnalysisOnce(input) {
  let after = input?.after ?? null;
  const seen = new Set(after === null ? [] : [after]);
  let hadCandidates = after !== null;
  for (let page = 0; page < MAX_PAGES_PER_ATTEMPT; page += 1) {
    const queue = await pollAmuxV19SessionAnalysisCandidateIds({ ...input, after });
    if (queue.kind !== "candidates") return { kind: queue.kind };
    hadCandidates ||= queue.candidates.length > 0;
    const candidate = queue.candidates.find(({ modelId }) => {
      const approved = amuxV4ApprovedAnalysisCliForModel(modelId);
      return amuxV4CanClaimAnalysisCli(approved, modelId);
    });
    if (candidate) return { kind: "discovered", candidate };
    if (!queue.hasMore) return { kind: hadCandidates ?
      "catalog_unapproved" : "idle" };
    if (seen.has(queue.nextCursor)) return { kind: "unavailable" };
    seen.add(queue.nextCursor);
    if (page === MAX_PAGES_PER_ATTEMPT - 1) {
      return { kind: "more_unexamined", after: queue.nextCursor };
    }
    after = queue.nextCursor;
  }
  return { kind: "unavailable" };
}
