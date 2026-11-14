/** Prefetch at most two independent attempts through the existing reservation path. */
export function createReviewAttemptQueue<Candidate extends { id: string }, Outcome extends { record: { status: string } }>(
  candidates: Candidate[],
  attempt: (candidate: Candidate) => Promise<Outcome>,
  parallel: boolean,
) {
  // Capture rejection immediately: a slower primary must not leave a rejected
  // secondary promise unhandled. Drain both before returning from the service.
  const pending = new Map(parallel ? candidates.slice(0, 2).map(candidate => [candidate.id,
    attempt(candidate).then(value => ({ value }), error => ({ error })),
  ] as const) : []);
  const all = [...pending.values()];
  return {
    async run(candidate: Candidate): Promise<Outcome> {
      const prefetched = pending.get(candidate.id);
      if (!prefetched) return attempt(candidate);
      pending.delete(candidate.id);
      const result = await prefetched;
      if ("error" in result) throw result.error;
      if (result.value.record.status !== "refused") return result.value;
      // A parallel reservation may hit a concurrency/credit hold. Once both
      // leases have settled and released, give the normal sequential path its
      // original chance. No rejected reservation made a provider call.
      await Promise.all(all);
      return attempt(candidate);
    },
    async drain() { await Promise.all(all); },
  };
}

/**
 * Whether a failed reviewer generation is worth sending again. A request that
 * hit its own deadline is not: the same reviewer on the same prompt timing out
 * once is evidence it will time out again, and the retry doubled the wait
 * before a run fell back to primary_only (two 45 s deadlines, ~90 s).
 */
export function shouldRetryReviewGeneration(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const name = (current as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") return false;
    current = (current as { cause?: unknown }).cause;
  }
  return true;
}
