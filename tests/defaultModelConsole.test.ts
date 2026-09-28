import assert from "node:assert/strict";
import test from "node:test";
import { APP_DEFAULTS, GUEST_BRAND_TRIO_MODEL_IDS, GUEST_FALLBACK_MODEL_IDS } from "../lib/appDefaults";
import {
  APPLICATION_FALLBACK_PROTECTED,
  assessFallbackTransition,
  describeGuestDefault,
  effectiveGuestLeadModelId,
  fallbackTransitionRequestText,
  replacementOptionDisabled,
  replacementRole,
  substituteIfTrioMemberRemoved,
} from "../lib/defaultModelConsole";
import { adoptionReplacementRefusal } from "../lib/modelAdoptionDraft";
import { indexGuestLeadRows } from "../lib/guestLeadFacts";
import { staticModelRegistrySeedRows } from "../lib/modelRegistryShared";

const eligible = (id: string) =>
  (GUEST_BRAND_TRIO_MODEL_IDS as readonly string[]).includes(id);

test("a missing guest-lead row still resolves to the compiled lead", () => {
  assert.equal(effectiveGuestLeadModelId(null, eligible), APP_DEFAULTS.guestDefaultModelId);
  assert.equal(
    effectiveGuestLeadModelId("not-a-trio-model", eligible),
    APP_DEFAULTS.guestDefaultModelId
  );
});

test("an ineligible stored lead is not the lead guests see", () => {
  const described = describeGuestDefault({
    storedLead: "claude-haiku-4-5",
    isEligible: (id) => id !== "claude-haiku-4-5" && eligible(id),
  });
  assert.equal(described.storedNotApplied, true);
  assert.notEqual(described.effectiveLeadId, "claude-haiku-4-5");
  assert.ok(described.ineligibleTrioIds.includes("claude-haiku-4-5"));
});

test("the application fallback cannot be selected as a replacement", () => {
  const role = replacementRole(APP_DEFAULTS.defaultModelId, APP_DEFAULTS.defaultModelId);
  assert.equal(role, "application_fallback");
  assert.equal(replacementOptionDisabled(role), true);
  const refusal = adoptionReplacementRefusal({
    adoptedModelId: "gpt-6-luna",
    adoptedProvider: "openai",
    replacesModelId: APP_DEFAULTS.defaultModelId,
    predecessor: {
      catalogDeleted: false,
      replacementModelId: null,
      provider: "openai",
      isApplicationDefault: true,
      isGuestDefault: true,
    },
  });
  assert.equal(refusal?.code, APPLICATION_FALLBACK_PROTECTED);
  assert.equal(refusal?.status, 409);
});

test("a guest-trio member that is not the lead is a warning, not a block", () => {
  const member = GUEST_BRAND_TRIO_MODEL_IDS.find((id) => id !== APP_DEFAULTS.defaultModelId);
  assert.ok(member);
  assert.equal(replacementRole(member, APP_DEFAULTS.defaultModelId), "guest_trio");
  assert.equal(replacementOptionDisabled("guest_trio"), false);
  const substitute = substituteIfTrioMemberRemoved(
    member,
    APP_DEFAULTS.defaultModelId,
    (id) =>
      eligible(id) || (GUEST_FALLBACK_MODEL_IDS as readonly string[]).includes(id)
  );
  assert.equal(typeof substitute, "string");
});

test("a fallback transition check fails a registry-only model and the copy does not apply it", () => {
  const checks = assessFallbackTransition({
    candidate: {
      enabled: true,
      publiclyListed: true,
      catalogDeleted: false,
      status: "enabled",
      minimumPlan: "Guest",
      usageClass: "standard",
      creditWeight: 1,
    },
    inCodeCatalog: false,
    hasPricingProfile: false,
    fallbackCreditWeight: 1,
  });
  assert.equal(checks.find((check) => check.id === "code_catalog")?.pass, false);
  assert.equal(checks.find((check) => check.id === "pricing_profile")?.pass, false);
  assert.equal(checks.find((check) => check.id === "registry_live")?.pass, true);
  const text = fallbackTransitionRequestText({ candidateId: "gpt-6-luna", checks });
  assert.match(text, /does not change the default/);
  assert.match(text, /gpt-6-luna/);
  assert.doesNotMatch(text, /sk-|api[_-]?key/i);
});

test("one invalid guest-lead row does not reject the rest", () => {
  const seed = staticModelRegistrySeedRows().find((entry) => entry.id === "gpt-5-6-luna");
  assert.ok(seed);
  const valid = {
    ...seed,
    updatedById: null,
    updatedByEmail: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const invalid = {
    ...valid,
    id: "bad-guest-lead",
    apiBaseUrl: "https://invalid.example/v1",
  };
  const indexed = indexGuestLeadRows([valid, invalid]);
  assert.equal(indexed.has("gpt-5-6-luna"), true);
  assert.equal(indexed.has("bad-guest-lead"), false);
});
