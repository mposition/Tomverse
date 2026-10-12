import assert from "node:assert/strict";
import { test } from "node:test";
const { selectGuestChatAutoModel } = await import(
  "../lib/guestChatAutoSelection.ts"
);

const candidate = (id, creditWeight, minimumPlan = "Guest") => ({
  id,
  name: id,
  provider: "openai",
  apiModel: id,
  enabled: true,
  publiclyListed: true,
  cataloguePath: "hosted",
  usageClass: "standard",
  reasoning: "medium",
  qualityBand: "balanced",
  minimumPlan,
  creditWeight,
  contextWindowTokens: 128_000,
  maxOutputTokens: 4_096,
  reservationOutputTokens: 1_024,
  supportsImages: false,
  supportsAttachments: false,
  supportsWebSearch: false,
});

const base = {
  authorityVerified: true,
  text: "Explain one concept.",
  attachments: [],
  attachmentsUnmeasurable: false,
  webSearchRequested: false,
  searchBackendReadiness: {},
  models: [candidate("guest-a", 1), candidate("guest-b", 2),
    candidate("paid-only", 1, "Free")],
  reservedInputTokens: 200,
  requestOutputCapTokens: 1_024,
  availableCredits: 2,
  creditsByModelId: { "guest-a": 1, "guest-b": 2, "paid-only": 1 },
};

test("Guest Auto refuses a structural request without verified authority", () => {
  assert.deepEqual(selectGuestChatAutoModel({ ...base,
    authorityVerified: false }), {
    routed: false,
    reason: "authority_refused",
  });
});

test("Guest Auto selects only from Router candidates admitted for Guest", () => {
  const result = selectGuestChatAutoModel(base);
  assert.equal(result.routed, true);
  assert.notEqual(result.modelId, "paid-only");
  assert.ok(["guest-a", "guest-b"].includes(result.modelId));
});

test("Guest Auto refuses when measured attachments are unavailable", () => {
  assert.deepEqual(selectGuestChatAutoModel({ ...base,
    attachmentsUnmeasurable: true }), {
    routed: false,
    reason: "attachments_unmeasurable",
  });
});

test("Guest Auto refuses rather than silently dispatching outside remaining credits", () => {
  const result = selectGuestChatAutoModel({ ...base,
    availableCredits: 0,
    creditsByModelId: { "guest-a": 1, "guest-b": 2, "paid-only": 1 },
  });
  assert.equal(result.routed, false);
  assert.equal(result.reason, "no_candidate");
});
