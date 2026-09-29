import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parseAmuxClaimRequest } from "@/lib/amux/claimContract";
import { schemaValidAmuxRoutingCandidate } from "./amuxClaimFixture.ts";

test("claim refusal fixtures satisfy the route routing-evidence schema", () => {
  for (const worker of ["codex-missing-task", "claude-mismatch"]) {
    const parsed = parseAmuxClaimRequest({
      task_id: "TASK-1",
      worker,
      expected_revision: 0,
      decision: {
        scheduler_score: 32,
        scoring_version: "amux-global-priority-v1",
        signals: {
          scheduler: {
            pin: 0,
            age_hours: 0,
            type_weight: 12,
            priority_weight: 20,
            dependents: 0,
            dependent_weight: 0,
            drag: 0,
          },
          routing: {
            scoring_version: "amux-worker-router-v1",
            preferred_worker: null,
            selected_worker: null,
            preferred_score: null,
            selected_score: null,
            candidates: [schemaValidAmuxRoutingCandidate(worker)],
          },
        },
      },
    });

    assert.equal(
      parsed.success,
      true,
      parsed.success ? undefined : parsed.error.message,
    );
  }
});

test("the Rust-serialized canonical claim request satisfies the shared Zod contract", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(process.cwd(), "tests/fixtures/amux-claim-request-rust-v1.json"),
      "utf8",
    ),
  );
  const parsed = parseAmuxClaimRequest(fixture);
  assert.equal(
    parsed.success,
    true,
    parsed.success ? undefined : parsed.error.message,
  );
});
