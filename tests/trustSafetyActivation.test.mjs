import assert from "node:assert/strict";
import test from "node:test";

import {
  TRUST_SAFETY_ACTIVATION_ACTION,
  TRUST_SAFETY_CONFIG_FAULTS,
  TRUST_SAFETY_MODES,
  activationTransitionAllowed,
  deriveTrustSafetyActivation,
} from "../lib/trustSafetyActivationCore.ts";

/**
 * Activation derivation (docs/policy/trust-safety-compliance-agent.md §6).
 *
 * The rule under test is §6's "observer는 설정 행만 믿지 않는다": the mode is
 * believed only when all seven checks pass, and a replayed historical tuple
 * must not turn observation on.
 */

const ON = {
  config: { mode: "on", version: 4 },
  newestEntry: { id: "e4", toMode: "on", version: 4, entryHash: "h4", hmacValid: true },
  unhashedEntryExists: false,
  maxEntryVersion: 4,
  successor: null,
  pingUrlPresent: true,
};

const derive = (overrides) => deriveTrustSafetyActivation({ ...ON, ...overrides });

test("all seven checks passing with mode on permits the count and the ping", () => {
  assert.deepEqual(derive({}), {
    mode: "on",
    fault: null,
    countPermitted: true,
    pingPermitted: true,
  });
});

test("mode off is not a fault, and permits neither count nor ping", () => {
  const state = derive({
    config: { mode: "off", version: 5 },
    newestEntry: { id: "e5", toMode: "off", version: 5, entryHash: "h5", hmacValid: true },
    maxEntryVersion: 5,
  });
  assert.deepEqual(state, {
    mode: "off",
    fault: null,
    countPermitted: false,
    pingPermitted: false,
  });
});

test("a missing config row stops the count", () => {
  const state = derive({ config: null });
  assert.equal(state.fault, "config_row_missing");
  assert.equal(state.mode, null);
  assert.equal(state.countPermitted, false);
  assert.equal(state.pingPermitted, false);
});

test("no audit entry and an unverified signature are the same answer", () => {
  // There is nothing to verify in either case, so the mode has no audited
  // origin. §6 lists five counting faults and neither is a sixth kind.
  for (const newestEntry of [
    null,
    { id: "e4", toMode: "on", version: 4, entryHash: "h4", hmacValid: false },
    { id: "e4", toMode: "on", version: 4, entryHash: "h4", hmacValid: null },
    { id: "e4", toMode: "on", version: 4, entryHash: null, hmacValid: true },
  ]) {
    const state = derive({ newestEntry });
    assert.equal(state.fault, "signature_unverified");
    assert.equal(state.countPermitted, false);
  }
});

test("an unverifiable signature is not a verified one", () => {
  // hmacValid null means "could not check". Treating it as true is the hole
  // this asserts against.
  assert.equal(
    derive({ newestEntry: { ...ON.newestEntry, hmacValid: null } }).mode,
    null,
  );
});

test("the entry must be bound to the config row by mode and version", () => {
  for (const newestEntry of [
    { ...ON.newestEntry, toMode: "off" },
    { ...ON.newestEntry, version: 3 },
    { ...ON.newestEntry, version: null },
  ]) {
    assert.equal(derive({ newestEntry }).fault, "binding_mismatch");
  }
});

test("a replayed older tuple does not turn observation on", () => {
  // The whole point of check 5: a valid historical entry (version 2) is the
  // newest one presented while a later version exists. Believing it would let
  // an old "on" be replayed after the operator turned it off.
  const state = derive({
    config: { mode: "on", version: 2 },
    newestEntry: { id: "e2", toMode: "on", version: 2, entryHash: "h2", hmacValid: true },
    maxEntryVersion: 4,
  });
  assert.equal(state.fault, "binding_mismatch");
  assert.equal(state.mode, null);
  assert.equal(state.countPermitted, false);
});

test("an entry with no hash anywhere in this action stops the count", () => {
  const state = derive({ unhashedEntryExists: true });
  assert.equal(state.fault, "unhashed_entry_present");
  assert.equal(state.countPermitted, false);
});

test("a successor must point at the bound entry and verify itself", () => {
  for (const successor of [
    { previousHash: "something-else", entryHash: "h5", hmacValid: true },
    { previousHash: "h4", entryHash: "h5", hmacValid: false },
    { previousHash: "h4", entryHash: "h5", hmacValid: null },
    { previousHash: null, entryHash: "h5", hmacValid: true },
  ]) {
    assert.equal(derive({ successor }).fault, "chain_broken");
  }
  // A successor that points at it and verifies leaves the state believable.
  assert.equal(
    derive({ successor: { previousHash: "h4", entryHash: "h5", hmacValid: true } }).fault,
    null,
  );
});

test("a chain cut right after the bound entry is caught", () => {
  // Checking only the bound entry would accept this: the entry itself verifies,
  // and the break is one link later.
  const state = derive({
    successor: { previousHash: "h3", entryHash: "h5", hmacValid: true },
  });
  assert.equal(state.fault, "chain_broken");
  assert.equal(state.countPermitted, false);
});

test("on with no ping URL counts but does not ping", () => {
  // §6's sixth fault, and the only one that is not a counting fault: stopping
  // the count over a missing environment variable would hide the DSR numbers
  // for a reason that has nothing to do with them.
  const state = derive({ pingUrlPresent: false });
  assert.deepEqual(state, {
    mode: "on",
    fault: "ping_url_missing",
    countPermitted: true,
    pingPermitted: false,
  });
});

test("off with no ping URL is not a fault", () => {
  // An observer that is off sends no ping anyway, so a missing URL is nothing
  // for it to report.
  const state = derive({
    config: { mode: "off", version: 5 },
    newestEntry: { id: "e5", toMode: "off", version: 5, entryHash: "h5", hmacValid: true },
    maxEntryVersion: 5,
    pingUrlPresent: false,
  });
  assert.equal(state.fault, null);
  assert.equal(state.mode, "off");
});

test("a stored mode outside the two is not believed", () => {
  // The database CHECK should refuse it; reaching here means the row was
  // written around the constraint, which is not a third mode.
  const state = derive({
    config: { mode: "paused", version: 4 },
    newestEntry: { ...ON.newestEntry, toMode: "paused" },
  });
  assert.equal(state.mode, null);
  assert.equal(state.fault, "binding_mismatch");
});

test("the fault list is exactly §6's six", () => {
  assert.equal(TRUST_SAFETY_CONFIG_FAULTS.length, 6);
  assert.deepEqual([...TRUST_SAFETY_CONFIG_FAULTS].sort(), [
    "binding_mismatch",
    "chain_broken",
    "config_row_missing",
    "ping_url_missing",
    "signature_unverified",
    "unhashed_entry_present",
  ]);
});

test("the modes and the audit action are the ones §6 names", () => {
  assert.deepEqual([...TRUST_SAFETY_MODES], ["off", "on"]);
  assert.equal(TRUST_SAFETY_ACTIVATION_ACTION, "trust_safety.observer_activation_changed");
});

test("only off to on and on to off are allowed transitions", () => {
  assert.equal(activationTransitionAllowed({ fromMode: "off", toMode: "on" }), true);
  assert.equal(activationTransitionAllowed({ fromMode: "on", toMode: "off" }), true);
  // Re-requesting the current mode is refused, which §6 states explicitly.
  assert.equal(activationTransitionAllowed({ fromMode: "on", toMode: "on" }), false);
  assert.equal(activationTransitionAllowed({ fromMode: "off", toMode: "off" }), false);
  for (const bad of ["paused", "", "ON", "disabled"]) {
    assert.equal(activationTransitionAllowed({ fromMode: "off", toMode: bad }), false);
    assert.equal(activationTransitionAllowed({ fromMode: bad, toMode: "on" }), false);
  }
});
