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
    storedLead: "claude-haiku-5-5",
    isEligible: (id) => id !== "claude-haiku-5-5" && eligible(id),
  });
  assert.equal(described.storedNotApplied, true);
  assert.notEqual(described.effectiveLeadId, "claude-haiku-5-5");
  assert.ok(described.ineligibleTrioIds.includes("claude-haiku-5-5"));
});

test("the application fallback cannot be selected as a replacement", () => {
  const role = replacementRole(APP_DEFAULTS.defaultModelId, APP_DEFAULTS.defaultModelId);
  assert.equal(role, "application_fallback");
  assert.equal(replacementOptionDisabled(role), true);
  const refusal = adoptionReplacementRefusal({
    // A hypothetical successor: gpt-6-luna is the application fallback itself
    // since 2026-10-12, so it cannot stand in for the model replacing it.
    adoptedModelId: "gpt-7-luna",
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

test("an adoption that retires a trio member names its guest-eligible successor as the substitute", () => {
  const member = GUEST_BRAND_TRIO_MODEL_IDS.find((id) => id !== APP_DEFAULTS.defaultModelId)!;
  const isEligible = (id: string) =>
    id === "successor-guest" ||
    eligible(id) ||
    (GUEST_FALLBACK_MODEL_IDS as readonly string[]).includes(id);
  // The save sets the member's replacement to the adopted model.
  const toSuccessor = (successor: string) => (id: string) =>
    id === member ? successor : undefined;

  assert.equal(
    substituteIfTrioMemberRemoved(member, APP_DEFAULTS.defaultModelId, isEligible, toSuccessor("successor-guest")),
    "successor-guest"
  );
  // A successor guests cannot use (a Pro model, or one saved disabled) leaves
  // the slot to the fallback list, exactly as the guest screen does.
  assert.equal(
    substituteIfTrioMemberRemoved(member, APP_DEFAULTS.defaultModelId, isEligible, toSuccessor("successor-pro")),
    GUEST_FALLBACK_MODEL_IDS.find((id) => isEligible(id))
  );
});

test("replacing a member that is already limited still names the adoption's successor", () => {
  const member = GUEST_BRAND_TRIO_MODEL_IDS.find((id) => id !== APP_DEFAULTS.defaultModelId)!;
  // The member fails the default rule today (limited or unlisted); its slot is
  // filled now by its current replacement, "current-successor".
  const isEligible = (id: string) =>
    id !== member &&
    (id === "current-successor" ||
      id === "adopted-successor" ||
      eligible(id) ||
      (GUEST_FALLBACK_MODEL_IDS as readonly string[]).includes(id));
  const current = (id: string) => (id === member ? "current-successor" : undefined);
  const adoption = (id: string) => (id === member ? "adopted-successor" : undefined);
  assert.equal(
    substituteIfTrioMemberRemoved(member, APP_DEFAULTS.defaultModelId, isEligible, adoption, undefined, current),
    "adopted-successor"
  );
  // Judged with the adoption's resolver for both, the change disappears --
  // the defect this parameter fixes.
  assert.equal(
    substituteIfTrioMemberRemoved(member, APP_DEFAULTS.defaultModelId, isEligible, adoption),
    null
  );
  // An adoption that keeps today's successor changes nothing.
  assert.equal(
    substituteIfTrioMemberRemoved(member, APP_DEFAULTS.defaultModelId, isEligible, current, undefined, current),
    null
  );
});

test("the effective lead follows a retired lead's successor", () => {
  const lead = APP_DEFAULTS.guestDefaultModelId;
  const isEligible = (id: string) => id !== lead && (id === "lead-successor" || eligible(id));
  assert.equal(
    effectiveGuestLeadModelId(lead, isEligible, (id) => (id === lead ? "lead-successor" : undefined)),
    "lead-successor"
  );
  // Without the resolver the next trio member leads instead.
  assert.notEqual(effectiveGuestLeadModelId(lead, isEligible), "lead-successor");
});

test("a stored lead succeeded in its slot is applied, and a lost provider is named", () => {
  const [openai, anthropic, google] = GUEST_BRAND_TRIO_MODEL_IDS;
  const isEligible = (id: string) => id !== anthropic && (id === "claude-successor" || eligible(id));
  const resolveReplacement = (id: string, accept: (candidate: string) => boolean = () => true) =>
    id === anthropic && accept("claude-successor") ? "claude-successor" : undefined;
  const providers: Record<string, string> = {
    [openai]: "openai",
    [anthropic]: "anthropic",
    "claude-successor": "anthropic",
    [google]: "google",
  };
  const succeeded = describeGuestDefault({
    storedLead: anthropic,
    isEligible,
    resolveReplacement,
    providerOf: (id) => providers[id] ?? null,
  });
  assert.equal(succeeded.effectiveLeadId, "claude-successor");
  assert.equal(succeeded.storedNotApplied, false);
  assert.deepEqual(succeeded.missingProviders, []);

  // No successor: the slot is backfilled from the fallback list, the stored
  // lead is not what leads, and the Anthropic slot is gone.
  const stranded = describeGuestDefault({
    storedLead: anthropic,
    isEligible: (id) => id !== anthropic && (eligible(id) || (GUEST_FALLBACK_MODEL_IDS as readonly string[]).includes(id)),
    providerOf: (id) => providers[id] ?? "other",
  });
  assert.equal(stranded.storedNotApplied, true);
  assert.deepEqual(stranded.missingProviders, ["anthropic"]);
  // Without a provider lookup the console does not guess.
  assert.deepEqual(describeGuestDefault({ storedLead: null, isEligible }).missingProviders, []);
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
    webSearchOverride: null,
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
