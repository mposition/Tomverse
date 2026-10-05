// The genesis the Admin screen offers (docs/policy/sre-ops.md §8): exactly
// one per chain state, and every offer is one the transition table allows.

import assert from "node:assert/strict";
import test from "node:test";

import { genesisOffer, genesisRefusal } from "../scripts/ops-observer/genesis-core.mjs";

const head = (mode) => ({ genesisId: "00000000-0000-4000-8000-000000000001", generation: 2, mode, createdAt: "2026-10-01T00:00:00.000Z" });

test("each chain state gets its one genesis, or none", () => {
  assert.deepEqual(genesisOffer({ head: null, trustReason: "state_missing" }), { reason: "initial", mode: "shadow" });
  assert.deepEqual(genesisOffer({ head: head("shadow"), trustReason: "unenforced_write" }), { reason: "recovery", mode: "shadow" });
  assert.deepEqual(genesisOffer({ head: head("live"), trustReason: "state_missing" }), { reason: "recovery", mode: "live" });
  assert.deepEqual(genesisOffer({ head: head("shadow"), trustReason: "trusted" }), { reason: "activation", mode: "live" });
  assert.equal(genesisOffer({ head: head("live"), trustReason: "trusted" }), null);
  assert.equal(genesisOffer({ head: head("paused"), trustReason: "schema" }), null);
});

test("every offer passes the transition table the trigger enforces", () => {
  for (const [h, trustReason] of [[null, "state_missing"], [head("shadow"), "schema"], [head("live"), "audit_unverified"], [head("shadow"), "trusted"]]) {
    const offer = genesisOffer({ head: h, trustReason });
    const refusal = genesisRefusal(
      { ...offer, supersedesGenesisId: h ? h.genesisId : null },
      h ? { id: h.genesisId, mode: h.mode } : null,
    );
    assert.equal(refusal, null, JSON.stringify({ h, trustReason }));
  }
});
