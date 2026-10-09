import assert from "node:assert/strict";
import { test } from "node:test";

import { runAmuxV4LocalAnalysisTrigger } from
  "../lib/amux/ideaLocalAnalysisTrigger.mjs";

test("an unknown result leaves the durable halt marker and blocks replay", async () => {
  let marked = false;
  let calls = 0;
  const state = {
    claim: async () => { if (marked) return false; marked = true; return true; },
    release: async () => { marked = false; },
  };
  assert.deepEqual(await runAmuxV4LocalAnalysisTrigger(async () => {
    calls += 1;
    return { kind: "claim_committed_unexecuted" };
  }, state), { kind: "claim_committed_unexecuted" });
  assert.deepEqual(await runAmuxV4LocalAnalysisTrigger(async () => {
    calls += 1;
    return { kind: "draft_ready" };
  }, state), { kind: "halted" });
  assert.equal(calls, 1);
  assert.equal(marked, true);
});

test("a known settled result clears the marker for the next one-shot", async () => {
  let marked = false;
  const state = {
    claim: async () => { if (marked) return false; marked = true; return true; },
    release: async () => { marked = false; },
  };
  for (const kind of ["idle", "draft_ready", "provider_failed", "disabled",
    "catalog_unapproved", "unavailable", "refused"]) {
    assert.deepEqual(await runAmuxV4LocalAnalysisTrigger(async () =>
      ({ kind }), state), { kind });
    assert.equal(marked, false);
  }
});

test("a thrown runner cannot clear a claimed marker", async () => {
  let released = false;
  assert.deepEqual(await runAmuxV4LocalAnalysisTrigger(async () => {
    throw new Error("transport failed");
  }, { claim: async () => true, release: async () => { released = true; } }),
  { kind: "outcome_unknown" });
  assert.equal(released, false);
});
