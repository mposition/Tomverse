import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// Orchestration policy version 20, section 1: a recover whose earlier
// transaction committed a receipt (the quota sweep, or an earlier reclaim)
// must not turn a later deadline into a known 200. The production reclaim
// loops run here against a boundary that hands out one candidate and then
// runs out of time on the write.

const ROOT = resolve(import.meta.dirname, "..", "..");
const moduleUrl = (relative: string) =>
  pathToFileURL(resolve(ROOT, relative)).href;

let receiptsMayHaveCommitted = false;
let boundaryCalls = 0;

class AmuxDbBoundaryError extends Error {
  constructor(
    readonly code: string,
    readonly boundary = "test",
  ) {
    super(code);
  }
}

mock.module(moduleUrl("lib/amux/dbBoundary.ts"), {
  namedExports: {
    AMUX_DB_BOUNDARIES: new Proxy({}, { get: (_target, name) => String(name) }),
    AmuxDbBoundaryError,
    amuxBoundaryWithAttachment: (boundary: unknown) => boundary,
    amuxRouteOrchestratorReceiptsMayHaveCommitted: () => receiptsMayHaveCommitted,
    withAmuxDbBoundary: async () => {
      boundaryCalls += 1;
      // The candidate read, then the write that runs out of time.
      if (boundaryCalls === 1) {
        return [
          {
            id: "attempt-1",
            worker: "worker-1",
            taskId: "task-1",
            owner: "worker-1",
            revision: 1,
            claimedAt: new Date(0),
          },
        ];
      }
      throw new AmuxDbBoundaryError("AMUX_DB_DEADLINE_EXCEEDED");
    },
  },
});

const loadExecution = () => import(moduleUrl("lib/amux/execution.ts"));

for (const name of ["reclaimExpiredAmuxExecutions", "reclaimExpiredAmuxClaims"] as const) {
  test(`${name}: a deadline before any receipt ends the loop as more work`, async () => {
    receiptsMayHaveCommitted = false;
    boundaryCalls = 0;
    let more = 0;
    const execution = await loadExecution();
    const reclaimed = await execution[name]({ onMoreWork: () => (more += 1) });
    assert.equal(reclaimed, 0);
    assert.equal(more, 1);
  });

  test(`${name}: a deadline after a receipt may have committed reaches the route`, async () => {
    receiptsMayHaveCommitted = true;
    boundaryCalls = 0;
    let more = 0;
    const execution = await loadExecution();
    await assert.rejects(
      () => execution[name]({ onMoreWork: () => (more += 1) }),
      (error: unknown) =>
        error instanceof AmuxDbBoundaryError && error.code === "AMUX_DB_DEADLINE_EXCEEDED",
    );
    assert.equal(more, 0);
  });
}
