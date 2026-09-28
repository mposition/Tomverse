import assert from "node:assert/strict";
import test from "node:test";

import { amuxStagingEvidenceDigests } from "../lib/amux/stagingEvidenceCore.ts";

const observation = (generatedAt, ageSeconds) => ({
  schema_version: "amux-staging-evidence-v1",
  generated_at: generatedAt,
  deployment_revision: "a".repeat(40),
  incident: {
    valid: true,
    state: {
      state: "normal",
      changed_at: "2026-09-21T00:00:00.000Z",
    },
  },
  latest_quota_by_worker: [
    {
      worker: "worker-a",
      observed_at: "2026-09-21T00:00:00.000Z",
      age_seconds: ageSeconds,
    },
  ],
});

test("stable staging digest excludes capture time and derived quota age", () => {
  const first = amuxStagingEvidenceDigests(
    observation("2026-09-21T00:01:00.000Z", 60),
  );
  const second = amuxStagingEvidenceDigests(
    observation("2026-09-21T00:02:00.000Z", 120),
  );
  assert.equal(
    first.stable_state_digest_sha256,
    second.stable_state_digest_sha256,
  );
  assert.notEqual(
    first.observation_digest_sha256,
    second.observation_digest_sha256,
  );
});
