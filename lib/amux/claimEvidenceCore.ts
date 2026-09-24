export const decideAmuxClaimEvidence = (input: {
  internally_consistent: boolean;
  matches_claim_time_authority: boolean;
}) => ({
  allowed: input.internally_consistent,
  record_drift:
    input.internally_consistent && !input.matches_claim_time_authority,
});

export const compareAmuxRoutingRank = (input: {
  left_worker: string;
  left_score: number;
  right_worker: string;
  right_score: number;
}) =>
  input.right_score - input.left_score ||
  (input.left_worker < input.right_worker
    ? -1
    : input.left_worker > input.right_worker
      ? 1
      : 0);

export const isSelectedAmuxWorkerOwnershipReady = (
  candidates: readonly {
    worker: {
      worker_name: string;
      running: boolean;
      status: string;
      dispatch_ready: boolean;
      archived: boolean;
      paused: boolean;
      isolated: boolean;
      blocked: boolean;
    };
  }[],
  worker: string,
) =>
  candidates.some(
    (candidate) =>
      candidate.worker.worker_name === worker &&
      !candidate.worker.archived &&
      !candidate.worker.paused &&
      !candidate.worker.isolated &&
      !candidate.worker.blocked &&
      candidate.worker.running &&
      candidate.worker.status.toLowerCase() === "idle" &&
      candidate.worker.dispatch_ready,
  );
