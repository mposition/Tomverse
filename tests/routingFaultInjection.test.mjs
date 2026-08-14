import assert from "node:assert/strict";
import test from "node:test";

import {
  FAULT_INJECTION_SECRET_ENV,
  INJECTABLE_FAULTS,
  InjectedProviderFault,
  decideFaultInjection,
  faultApplies,
  faultedReader,
} from "../lib/routingFaultInjection.ts";

// A switch that makes provider calls fail is a denial-of-service lever, so
// most of this file is about the ways it must stay off.

const SECRET = "drill-secret-long-enough";
const staging = {
  [FAULT_INJECTION_SECRET_ENV]: SECRET,
  APP_ENV: "staging",
};
const header = (fault, secret = SECRET) => `${secret}:${fault}`;

test("a drill request on staging with the right secret injects", () => {
  const decision = decideFaultInjection(header("attempt_0_pre_token"), staging);
  assert.deepEqual(decision, { inject: true, fault: "attempt_0_pre_token" });
});

test("production never injects, whatever the request carries", () => {
  for (const environment of [
    { ...staging, APP_ENV: "production" },
    { ...staging, APP_ENV: undefined, RAILWAY_ENVIRONMENT_NAME: "production" },
    // Unlabelled production build: the resolver fails closed, and so does this.
    { [FAULT_INJECTION_SECRET_ENV]: SECRET, NODE_ENV: "production" },
  ]) {
    const decision = decideFaultInjection(header("attempt_0_pre_token"), environment);
    assert.equal(decision.inject, false);
    assert.equal(decision.reason, "production");
  }
});

test("a staging box nobody set up for a drill cannot be driven into one", () => {
  for (const environment of [
    { APP_ENV: "staging" },
    { APP_ENV: "staging", [FAULT_INJECTION_SECRET_ENV]: "" },
    // Short enough not to be a secret. Treating it as configured would leave
    // the header as the only real lock.
    { APP_ENV: "staging", [FAULT_INJECTION_SECRET_ENV]: "short" },
  ]) {
    const decision = decideFaultInjection(header("attempt_0_pre_token"), environment);
    assert.equal(decision.inject, false);
    assert.equal(decision.reason, "not_configured");
  }
});

test("nothing is injected without the request asking", () => {
  for (const value of [null, undefined, ""]) {
    const decision = decideFaultInjection(value, staging);
    assert.equal(decision.inject, false);
    assert.equal(decision.reason, "no_header");
  }
});

test("a wrong secret is refused, and refused before the fault is validated", () => {
  // Checked in this order so an unauthenticated caller cannot enumerate the
  // fault vocabulary from the refusal it gets back.
  const decision = decideFaultInjection(header("attempt_0_pre_token", "wrong"), staging);
  assert.equal(decision.reason, "bad_secret");

  const nonsense = decideFaultInjection(header("not_a_fault", "wrong"), staging);
  assert.equal(nonsense.reason, "bad_secret");
});

test("an unknown fault is refused rather than approximated", () => {
  const decision = decideFaultInjection(header("attempt_9_sideways"), staging);
  assert.equal(decision.reason, "unknown_fault");
});

test("a malformed header is refused by name", () => {
  for (const value of ["no-separator", ":leading", SECRET]) {
    const decision = decideFaultInjection(value, staging);
    assert.equal(decision.inject, false, value);
    assert.ok(["malformed_header", "unknown_fault"].includes(decision.reason));
  }
});

test("every refusal is distinguishable", () => {
  // A drill that silently does not inject looks exactly like a fallback that
  // silently did not happen, and those are the two things the drill exists to
  // tell apart.
  const reasons = new Set([
    decideFaultInjection(header("attempt_0_pre_token"), {}).reason,
    decideFaultInjection(header("attempt_0_pre_token"), {
      ...staging,
      APP_ENV: "production",
    }).reason,
    decideFaultInjection(null, staging).reason,
    decideFaultInjection("no-separator", staging).reason,
    decideFaultInjection(header("attempt_0_pre_token", "wrong"), staging).reason,
    decideFaultInjection(header("nope"), staging).reason,
  ]);
  assert.equal(reasons.size, 6);
});

test("a fault names the attempt it fires on, so a drill cannot be vague", () => {
  assert.equal(faultApplies("attempt_0_pre_token", 0, "pre_token"), true);
  assert.equal(faultApplies("attempt_0_pre_token", 1, "pre_token"), false);
  assert.equal(faultApplies("attempt_1_pre_token", 1, "pre_token"), true);
  assert.equal(faultApplies("attempt_1_pre_token", 0, "pre_token"), false);
  assert.equal(faultApplies("attempt_0_post_token", 0, "post_token"), true);
  assert.equal(faultApplies("attempt_0_post_token", 0, "pre_token"), false);
  assert.equal(faultApplies(null, 0, "pre_token"), false);
});

const scriptedReader = (chunks) => {
  let index = 0;
  return {
    cancelled: false,
    async read() {
      const value = chunks[index];
      index += 1;
      return value === undefined ? { done: true } : { done: false, value };
    },
    async cancel() {
      this.cancelled = true;
    },
  };
};

test("a pre-token fault fails before any chunk reaches the caller", async () => {
  const reader = faultedReader(
    scriptedReader(["never", "seen"]),
    "attempt_0_pre_token",
    0
  );
  await assert.rejects(reader.read(), InjectedProviderFault);
});

test("a post-token fault lets one chunk through first", async () => {
  // §7's rule about visible tokens is what the drill's control case checks:
  // after a token there is no substitution, whatever the failure looks like.
  const reader = faultedReader(
    scriptedReader(["hello", "world"]),
    "attempt_0_post_token",
    0
  );
  assert.deepEqual(await reader.read(), { done: false, value: "hello" });
  await assert.rejects(reader.read(), InjectedProviderFault);
});

test("an attempt the fault does not name reads normally", async () => {
  const reader = faultedReader(scriptedReader(["fine"]), "attempt_0_pre_token", 1);
  assert.deepEqual(await reader.read(), { done: false, value: "fine" });
});

test("no fault leaves the reader exactly as it was", () => {
  const original = scriptedReader(["fine"]);
  assert.equal(faultedReader(original, null, 0), original);
});

test("the injected error is recognisable, so a drill is never read as an outage", async () => {
  const reader = faultedReader(scriptedReader([]), "attempt_0_pre_token", 0);
  await reader.read().catch((error) => {
    assert.ok(error instanceof InjectedProviderFault);
    assert.equal(error.name, "InjectedProviderFault");
    assert.equal(error.fault, "attempt_0_pre_token");
  });
});

test("the fault vocabulary is exactly the drill's steps", () => {
  // Adding one is a decision about what the drill is for, not a convenience.
  assert.deepEqual(
    [...INJECTABLE_FAULTS],
    ["attempt_0_pre_token", "attempt_1_pre_token", "attempt_0_post_token"]
  );
});
