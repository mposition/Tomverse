import { createHash } from "node:crypto";

type StagingObservation = {
  generated_at: string;
  incident: {
    valid: boolean;
    state: { changed_at: string | null; [key: string]: unknown };
    [key: string]: unknown;
  };
  latest_quota_by_worker: Array<{
    age_seconds: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const amuxStagingEvidenceDigests = (
  observation: StagingObservation,
) => {
  const stableObservation = {
    ...observation,
    generated_at: null,
    incident: {
      ...observation.incident,
      state: observation.incident.valid
        ? observation.incident.state
        : { ...observation.incident.state, changed_at: null },
    },
    latest_quota_by_worker: observation.latest_quota_by_worker.map((row) => ({
      ...row,
      age_seconds: null,
    })),
  };
  return {
    stable_state_digest_sha256: digest(stableObservation),
    observation_digest_sha256: digest(observation),
  };
};
