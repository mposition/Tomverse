import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_CLAIM_GATES,
  resolveMarketingClaimGate,
} from "@/lib/marketingClaimGates";
import { resolveMarketingClaim } from "@/lib/marketingClaims";

// The S1 plan's S1e fact-source list: "feature public: claim `gate` resolves
// via existing production flag reader; unreadable -> not public".

test("the registry is empty, and frozen so a caller cannot add to it", () => {
  // Empty for the same reason MARKETING_CLAIMS is: no claim names a gate yet.
  assert.deepEqual(Object.keys(MARKETING_CLAIM_GATES), []);

  assert.throws(
    () => {
      "use strict";
      MARKETING_CLAIM_GATES["feature.invented"] = async () => true;
    },
    TypeError,
    "a gate is bound in the same change as the claim that needs it",
  );
});

test("an unbound gate is unreadable, not off", () => {
  // A claim naming a flag this build does not bind means the registry has
  // drifted from the claims, which somebody has to look at. Answering `false`
  // would report it as a feature that was switched off.
  return resolveMarketingClaimGate("feature.nobodyBoundThis").then((value) => {
    assert.equal(value, null);
  });
});

test("a bound gate answers what its reader answers", async () => {
  const registry = {
    "feature.on": async () => true,
    "feature.off": async () => false,
  };
  assert.equal(await resolveMarketingClaimGate("feature.on", registry), true);
  assert.equal(await resolveMarketingClaimGate("feature.off", registry), false);
});

test("a reader that throws is unreadable, and carries nothing out with it", async () => {
  const registry = {
    "feature.broken": async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.4:5432");
    },
  };
  const value = await resolveMarketingClaimGate("feature.broken", registry);
  assert.equal(
    value,
    null,
    "a database incident is not a feature being switched off",
  );
});

test("a prototype key is not a bound gate", async () => {
  for (const gate of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(await resolveMarketingClaimGate(gate), null, gate);
  }
});

test("the two unreadable states reach the claim resolver as different codes", () => {
  const claim = {
    id: "feature.example",
    type: "feature",
    statementKey: "faq.title",
    locales: ["en"],
    validUntil: "2099-01-01",
    gate: "feature.example",
    evidence: { kind: "page", pageRoute: "/faq", localeKey: "faq.title" },
  };
  const on = new Date("2026-09-20T00:00:00Z");

  assert.equal(
    resolveMarketingClaim({
      id: claim.id,
      locale: "en",
      on,
      gateEnabled: null,
      registry: [claim],
    }).refusal,
    "gate_unreadable",
  );
  assert.equal(
    resolveMarketingClaim({
      id: claim.id,
      locale: "en",
      on,
      gateEnabled: false,
      registry: [claim],
    }).refusal,
    "gate_off",
  );
});
