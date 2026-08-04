import assert from "node:assert/strict";
import test from "node:test";
import {
  decideMemoryInjection,
  hasApprovedExtractionPair,
  isInjectableProvenance,
} from "../lib/memoryInjectionGate.ts";
import { MEMORY_EXTRACTION_PROMPT_VERSION } from "../lib/memoryExtractionEvalRegister.ts";

const APPROVED = {
  extractionModelId: "qa-approved-model",
  promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
};
const CANDIDATE = {
  extractionModelId: "qa-candidate-model",
  promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
};

/** A register that does not depend on the shipped one's current contents. */
const REGISTER = [
  { ...APPROVED, status: "approved" },
  { ...CANDIDATE, status: "candidate" },
];

const NONE = { kind: "none" };
const allow = (overrides = {}) => ({
  isAuthenticated: true,
  injectionFlagEnabled: true,
  hasApprovedExtractionPair: true,
  accountMasterEnabled: true,
  conversationMode: "on",
  ...overrides,
});

test("every authority has to agree before a memory reaches a prompt", () => {
  assert.deepEqual(decideMemoryInjection(allow()), { allowed: true });
});

test("a guest is refused for having no account memory, not for a switch", () => {
  // Checked before the flag on purpose: a guest is refused the same way
  // whether the rollout is on or off, and the reason has to say which.
  assert.deepEqual(
    decideMemoryInjection(allow({ isAuthenticated: false })),
    { allowed: false, reason: "guest" }
  );
  assert.deepEqual(
    decideMemoryInjection(
      allow({ isAuthenticated: false, injectionFlagEnabled: false })
    ),
    { allowed: false, reason: "guest" }
  );
});

test("the rollout flag closes injection on its own", () => {
  assert.deepEqual(decideMemoryInjection(allow({ injectionFlagEnabled: false })), {
    allowed: false,
    reason: "flag_off",
  });
});

test("an enabled flag is not enough without an approved pair (§12.4)", () => {
  assert.deepEqual(
    decideMemoryInjection(allow({ hasApprovedExtractionPair: false })),
    { allowed: false, reason: "no_approved_pair" }
  );
});

test("the owner's master toggle is its own authority, not a rollout control", () => {
  assert.deepEqual(decideMemoryInjection(allow({ accountMasterEnabled: false })), {
    allowed: false,
    reason: "account_off",
  });
});

test("a conversation set to off refuses even when the account allows it", () => {
  assert.deepEqual(decideMemoryInjection(allow({ conversationMode: "off" })), {
    allowed: false,
    reason: "conversation_off",
  });
});

test("each refusal is reported as itself, so §22 can tell them apart", () => {
  const reasons = new Set(
    [
      allow({ isAuthenticated: false }),
      allow({ injectionFlagEnabled: false }),
      allow({ hasApprovedExtractionPair: false }),
      allow({ accountMasterEnabled: false }),
      allow({ conversationMode: "off" }),
    ].map((input) => decideMemoryInjection(input).reason)
  );
  assert.equal(reasons.size, 5);
});

test("an approved, unrevoked pair is what makes the account-level gate pass", () => {
  assert.equal(hasApprovedExtractionPair(NONE, REGISTER), true);
  // Candidate-only register: the eval procedure has not approved anything.
  assert.equal(
    hasApprovedExtractionPair(NONE, [{ ...CANDIDATE, status: "candidate" }]),
    false
  );
  assert.equal(hasApprovedExtractionPair(NONE, []), false);
});

test("revoking a pair closes the gate that pair was holding open", () => {
  assert.equal(
    hasApprovedExtractionPair({ kind: "revoked", pairs: [APPROVED] }, REGISTER),
    false
  );
  // Unreadable revocation content reads as revoke-all, and the gate follows.
  assert.equal(hasApprovedExtractionPair({ kind: "revoke_all", reason: "malformed" }, REGISTER), false);
});

test("a memory is injectable only when its own producing pair is approved", () => {
  assert.equal(isInjectableProvenance(APPROVED, NONE, REGISTER), true);
  assert.equal(isInjectableProvenance(CANDIDATE, NONE, REGISTER), false);
});

test("revoking one pair leaves the other pairs' memories injectable", () => {
  // The account-level gate cannot express this: it only knows whether *some*
  // pair is approved, so without the per-item rule a revoked pair's memories
  // would keep reaching prompts for as long as any other pair stood.
  const second = {
    extractionModelId: "qa-second-model",
    promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
  };
  const register = [...REGISTER, { ...second, status: "approved" }];
  const revoked = { kind: "revoked", pairs: [APPROVED] };
  assert.equal(hasApprovedExtractionPair(revoked, register), true);
  assert.equal(isInjectableProvenance(APPROVED, revoked, register), false);
  assert.equal(isInjectableProvenance(second, revoked, register), true);
});

test("a user-authored memory carries no pair and is not eval-gated", () => {
  assert.equal(
    isInjectableProvenance(
      { extractionModelId: null, promptVersion: null },
      { kind: "revoke_all", reason: "malformed" },
      REGISTER
    ),
    true
  );
});

test("half-written provenance is unreadable, so it is excluded", () => {
  for (const memory of [
    { extractionModelId: "qa-approved-model", promptVersion: null },
    { extractionModelId: null, promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION },
    { extractionModelId: "", promptVersion: "" },
  ]) {
    assert.equal(isInjectableProvenance(memory, NONE, REGISTER), false);
  }
});
