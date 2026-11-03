import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_CLAIM_GATES,
  readGateSafely,
  resolveMarketingClaimGate,
} from "@/lib/marketingClaimGates";
import { MARKETING_CLAIMS, marketingClaimUsable } from "@/lib/marketingClaims";

// A gate the registry does not bind never reaches its client.
const NO_DATABASE = {};

/**
 * Settings as a transaction sees them: `rows` exist when the lock runs, and
 * `lateRows` appear between the lock and the read, which the lock did not hold.
 */
const settingsDatabase = (rows, lateRows = {}) => ({
  $queryRaw: async (strings, keys) => {
    assert.match(strings.join("?"), /FOR SHARE/);
    return keys.filter((key) => Object.hasOwn(rows, key)).sort().map((key) => ({ key }));
  },
  appSetting: {
    findMany: async ({ where }) => {
      const all = { ...rows, ...lateRows };
      return where.key.in.filter((key) => Object.hasOwn(all, key)).map((key) => ({ key, value: all[key] }));
    },
  },
});

// The S1 plan's S1e fact-source list: "feature public: claim `gate` resolves
// via existing production flag reader; unreadable -> not public".

test("the registry binds exactly the gates the claims name, and is frozen", () => {
  const named = [...new Set(MARKETING_CLAIMS.map((claim) => claim.gate).filter(Boolean))].sort();
  assert.deepEqual(Object.keys(MARKETING_CLAIM_GATES).sort(), named);

  assert.throws(
    () => {
      "use strict";
      MARKETING_CLAIM_GATES["feature.invented"] = async () => true;
    },
    TypeError,
    "a gate is bound in the same change as the claim that needs it",
  );
});

test("a rollout gate is on only when its row says true", async () => {
  for (const [gate, key] of [
    ["feature.assistantProfiles", "feature.assistantProfilesEnabled"],
    ["feature.imageGeneration", "feature.imageGenerationEnabled"],
  ]) {
    assert.equal(await resolveMarketingClaimGate(gate, settingsDatabase({ [key]: "true" })), true, gate);
    assert.equal(await resolveMarketingClaimGate(gate, settingsDatabase({ [key]: "false" })), false, gate);
    assert.equal(await resolveMarketingClaimGate(gate, settingsDatabase({})), false, `${gate} missing row`);
    // A row the lock did not hold is not one the decision rests on.
    assert.equal(await resolveMarketingClaimGate(gate, settingsDatabase({}, { [key]: "true" })), false, `${gate} late row`);
  }
});

test("import and continue needs both flags", async () => {
  const gate = "feature.externalImportAndContinuation";
  const both = {
    "feature.externalConversationImportEnabled": "true",
    "feature.externalConversationContinuationEnabled": "true",
  };
  assert.equal(await resolveMarketingClaimGate(gate, settingsDatabase(both)), true);
  for (const key of Object.keys(both)) {
    assert.equal(await resolveMarketingClaimGate(gate, settingsDatabase({ ...both, [key]: "false" })), false, key);
  }
});

test("the attachments gate is a kill switch: only \"false\" turns it off", async () => {
  const gate = "feature.attachments";
  assert.equal(await resolveMarketingClaimGate(gate, settingsDatabase({})), true);
  assert.equal(await resolveMarketingClaimGate(gate, settingsDatabase({ "feature.attachmentsEnabled": "true" })), true);
  assert.equal(await resolveMarketingClaimGate(gate, settingsDatabase({ "feature.attachmentsEnabled": "false" })), false);
});

test("the question-refinement gate also honours the environment kill switch", async () => {
  const gate = "feature.promptRefiner";
  const on = settingsDatabase({ "feature.promptRefinerEnabled": "true" });
  const saved = process.env.PROMPT_REFINER_KILL_SWITCH;
  try {
    delete process.env.PROMPT_REFINER_KILL_SWITCH;
    assert.equal(await resolveMarketingClaimGate(gate, on), true);
    process.env.PROMPT_REFINER_KILL_SWITCH = "1";
    assert.equal(await resolveMarketingClaimGate(gate, on), false);
  } finally {
    if (saved === undefined) delete process.env.PROMPT_REFINER_KILL_SWITCH;
    else process.env.PROMPT_REFINER_KILL_SWITCH = saved;
  }
});

test("an unbound gate is unreadable, not off", () => {
  // A claim naming a flag this build does not bind means the registry has
  // drifted from the claims, which somebody has to look at. Answering `false`
  // would report it as a feature that was switched off.
  return resolveMarketingClaimGate("feature.nobodyBoundThis", NO_DATABASE).then((value) => {
    assert.equal(value, null);
  });
});

test("a bound gate answers what its reader answers", async () => {
  // Asked of the reader, not of a registry handed to the resolver: the
  // resolver reads only this module's registry, the way the link builders do.
  assert.equal(await readGateSafely(async () => true), true);
  assert.equal(await readGateSafely(async () => false), false);
});

test("a reader that throws is unreadable, and carries nothing out with it", async () => {
  const value = await readGateSafely(async () => {
    throw new Error("connect ECONNREFUSED 10.0.0.4:5432");
  });
  assert.equal(
    value,
    null,
    "a database incident is not a feature being switched off",
  );
});

test("a prototype key is not a bound gate", async () => {
  for (const gate of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(await resolveMarketingClaimGate(gate, NO_DATABASE), null, gate);
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
    marketingClaimUsable({ claim, locale: "en", on, gateEnabled: null }).refusal,
    "gate_unreadable",
  );
  assert.equal(
    marketingClaimUsable({ claim, locale: "en", on, gateEnabled: false }).refusal,
    "gate_off",
  );
});
