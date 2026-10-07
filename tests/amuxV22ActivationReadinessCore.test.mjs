import assert from "node:assert/strict";
import test from "node:test";
import { inspectAmuxActivationStages } from
  "../lib/amux/v22ActivationReadinessCore.ts";

test("staged activation never becomes permission from code and env alone", () => {
  const stages = inspectAmuxActivationStages([
    { id: "closed", gates: [{ id: "writer", codeLatch: false,
      environmentEnabled: true }] },
    { id: "unknown", gates: [{ id: "receipt", codeLatch: null,
      environmentEnabled: null }] },
    { id: "configured", gates: [{ id: "worker", codeLatch: true,
      environmentEnabled: true }] },
  ]);
  assert.deepEqual(stages.map((stage) => stage.status),
    ["closed", "unverified", "owner_evidence_required"]);
  assert.ok(stages.every((stage) => stage.activationAuthorized === false));
});
