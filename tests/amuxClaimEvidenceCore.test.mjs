import assert from "node:assert/strict";
import test from "node:test";

import {
  compareAmuxRoutingRank,
  decideAmuxClaimEvidence,
  isSelectedAmuxWorkerOwnershipReady,
} from "../lib/amux/claimEvidenceCore.ts";
import { scoreAmuxWorkers } from "../lib/amux/workerRouterCore.ts";

test("time-dependent authoritative drift is observed without blocking claim", () => {
  assert.deepEqual(
    decideAmuxClaimEvidence({
      internally_consistent: true,
      matches_claim_time_authority: false,
    }),
    { allowed: true, record_drift: true },
  );
});

test("internally inconsistent caller evidence remains rejected", () => {
  assert.deepEqual(
    decideAmuxClaimEvidence({
      internally_consistent: false,
      matches_claim_time_authority: false,
    }),
    { allowed: false, record_drift: false },
  );
});

test("sub-basis-point routing differences remain ordered by the real score", () => {
  const candidates = [
    { worker: "a-worker", score: 0.70001 },
    { worker: "z-worker", score: 0.70002 },
  ];
  candidates.sort((left, right) =>
    compareAmuxRoutingRank({
      left_worker: left.worker,
      left_score: left.score,
      right_worker: right.worker,
      right_score: right.score,
    }),
  );
  assert.equal(candidates[0]?.worker, "z-worker");
});

test("ownership readiness recognizes startable workers but rejects an unsafe idle boundary", () => {
  const worker = (worker_name, overrides = {}) => ({
    worker: {
      worker_name,
      running: true,
      status: "idle",
      dispatch_ready: true,
      archived: false,
      paused: false,
      isolated: false,
      blocked: false,
      ...overrides,
    },
  });
  const candidates = [
    worker("selected-without-boundary", { dispatch_ready: false }),
    worker("other-live-worker"),
    worker("startable-worker", {
      running: false,
      status: "stopped",
      dispatch_ready: false,
    }),
    worker("isolated-worker", { isolated: true }),
  ];
  assert.equal(
    isSelectedAmuxWorkerOwnershipReady(candidates, "selected-without-boundary"),
    false,
  );
  assert.equal(
    isSelectedAmuxWorkerOwnershipReady(candidates, "other-live-worker"),
    true,
  );
  assert.equal(
    isSelectedAmuxWorkerOwnershipReady(candidates, "startable-worker"),
    true,
  );
  assert.equal(
    isSelectedAmuxWorkerOwnershipReady(candidates, "isolated-worker"),
    false,
  );
});

test("server routing preserves busy preferred demand for the execution starter", () => {
  const candidate = (worker_name, provider, roles, overrides = {}) => ({
    worker: {
      worker_name,
      provider,
      model: null,
      routing_roles: roles,
      running: true,
      status: "idle",
      dispatch_ready: true,
      archived: false,
      paused: false,
      isolated: false,
      blocked: false,
      ...overrides,
    },
    predicted_success: null,
    quota_remaining: null,
    expected_speed: null,
    low_rework: null,
    low_human_attention: null,
    cost_efficiency: null,
    provider_exhausted: false,
  });
  const result = scoreAmuxWorkers(
    { task_kind: "migration", complexity: 8, risk: 1, files_expected: null },
    [
      candidate("devin-worker", "devin", ["migration", "multi_file"], {
        status: "busy",
        dispatch_ready: false,
      }),
      candidate("codex-impl", "codex", ["implementation"]),
    ],
  );
  assert.equal(result.preferred_worker, "devin-worker");
  assert.equal(result.selected_worker, "devin-worker");
});
