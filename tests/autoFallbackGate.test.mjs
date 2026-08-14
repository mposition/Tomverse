import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_FALLBACK_FLAG,
  autoFallbackFlagEnabled,
  autoFallbackScope,
} from "../lib/autoFallbackGate.ts";

const ON = { [AUTO_FALLBACK_FLAG]: "on" };

const scope = (overrides = {}) =>
  autoFallbackScope({
    routed: true,
    isGuest: false,
    toolsOffered: false,
    nativeSearchEnabled: false,
    deepResearch: false,
    hasAttachments: false,
    candidateCount: 1,
    environment: ON,
    ...overrides,
  });

test("a deployment that sets nothing runs no second provider call", () => {
  assert.equal(autoFallbackFlagEnabled({}), false);
  assert.equal(autoFallbackFlagEnabled({ [AUTO_FALLBACK_FLAG]: "" }), false);
  assert.equal(autoFallbackFlagEnabled({ [AUTO_FALLBACK_FLAG]: "true" }), false);
  assert.equal(autoFallbackFlagEnabled({ [AUTO_FALLBACK_FLAG]: "1" }), false);
  assert.equal(autoFallbackFlagEnabled({ [AUTO_FALLBACK_FLAG]: "ON" }), false);
  assert.equal(autoFallbackFlagEnabled(ON), true);
});

test("the flag is checked before anything about the turn", () => {
  // So a deployment with it off reports one reason for every turn, rather
  // than a distribution describing a feature nobody enabled.
  const off = autoFallbackScope({
    routed: false,
    isGuest: true,
    toolsOffered: true,
    nativeSearchEnabled: true,
    deepResearch: true,
    hasAttachments: true,
    candidateCount: 0,
    environment: {},
  });
  assert.deepEqual(off, { allowed: false, reason: "flag_off" });
});

test("a plain routed text turn with a candidate is in scope", () => {
  assert.deepEqual(scope(), { allowed: true });
});

test("a manual turn is out of scope, because §7 is about Auto's own choice", () => {
  assert.deepEqual(scope({ routed: false }), {
    allowed: false,
    reason: "not_routed",
  });
});

test("a guest turn is never routed, so it never falls back", () => {
  assert.equal(scope({ isGuest: true }).reason, "guest");
});

test("each excluded shape names itself", () => {
  for (const [override, reason] of [
    [{ deepResearch: true }, "deep_research"],
    [{ nativeSearchEnabled: true }, "web_search"],
    [{ toolsOffered: true }, "tools_offered"],
    [{ hasAttachments: true }, "attachments"],
    [{ candidateCount: 0 }, "no_candidate"],
  ]) {
    const result = scope(override);
    assert.equal(result.allowed, false, JSON.stringify(override));
    assert.equal(result.reason, reason);
  }
});

test("the reasons are distinguishable, which is the point of naming them", () => {
  const reasons = new Set(
    [
      scope({ routed: false }),
      scope({ isGuest: true }),
      scope({ deepResearch: true }),
      scope({ nativeSearchEnabled: true }),
      scope({ toolsOffered: true }),
      scope({ hasAttachments: true }),
      scope({ candidateCount: 0 }),
      autoFallbackScope({
        routed: true,
        isGuest: false,
        toolsOffered: false,
        nativeSearchEnabled: false,
        deepResearch: false,
        hasAttachments: false,
        candidateCount: 1,
        environment: {},
      }),
    ].map((result) => (result.allowed ? "allowed" : result.reason))
  );
  assert.equal(reasons.size, 8);
});

test("a searching turn is excluded even though its text streams normally", () => {
  // The exclusion is not about the shape of the stream. A native search has
  // already executed and been surcharged by the time the provider fails, and
  // the second attempt cannot inherit it.
  assert.equal(scope({ nativeSearchEnabled: true }).allowed, false);
});
