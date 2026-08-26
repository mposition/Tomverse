import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_DEFAULTS,
  isWebSearchEnabled,
  isWebSearchMode,
  normalizeWebSearchMode,
  WEB_SEARCH_MODES,
  WEB_SEARCH_TOGGLE_MODES,
  webSearchModeForToggle,
} from "../lib/appDefaults.ts";

// Web search is a switch. The stored vocabulary is wider than the offered one
// on purpose: rows and request bodies written before the switch existed still
// carry "auto", the mode that meant "ask me before searching". Rejecting it
// would turn old conversations into errors, so it is read rather than refused
// -- and how it is read is the whole safety property this file pins.

test("the stored enum still has three members and the switch offers two", () => {
  assert.deepEqual([...WEB_SEARCH_MODES], ["off", "auto", "always"]);
  assert.deepEqual([...WEB_SEARCH_TOGGLE_MODES], ["off", "always"]);
  // Still accepted on the wire -- the PATCH body and the chat payload have not
  // narrowed, which is what keeps an existing client from breaking.
  assert.equal(isWebSearchMode("auto"), true);
});

test("a stored 'always' stays on", () => {
  assert.equal(normalizeWebSearchMode("always"), "always");
  assert.equal(isWebSearchEnabled("always"), true);
});

test("a stored 'auto' reads as off, never as consent to search", () => {
  // "auto" was a request to be *asked* first. Reading it as on would convert
  // that into standing permission to search and to spend the surcharge, which
  // is consent nobody gave; off is the reading that takes nothing away, and
  // turning the switch on is one click.
  assert.equal(normalizeWebSearchMode("auto"), "off");
  assert.equal(isWebSearchEnabled("auto"), false);
});

test("anything unrecognised, missing or malformed reads as off", () => {
  for (const value of [
    "off",
    "ALWAYS",
    "sometimes",
    "",
    null,
    undefined,
    0,
    1,
    true,
    {},
    [],
  ]) {
    assert.equal(normalizeWebSearchMode(value), "off");
    assert.equal(isWebSearchEnabled(value), false);
  }
});

test("normalizing is idempotent and only ever yields an offered state", () => {
  for (const mode of WEB_SEARCH_MODES) {
    const once = normalizeWebSearchMode(mode);
    assert.equal(normalizeWebSearchMode(once), once);
    assert.ok(WEB_SEARCH_TOGGLE_MODES.includes(once));
  }
});

test("the switch writes back the two modes it can be in", () => {
  assert.equal(webSearchModeForToggle(true), "always");
  assert.equal(webSearchModeForToggle(false), "off");
  // Round trip: what the switch writes is what it reads back as.
  assert.equal(isWebSearchEnabled(webSearchModeForToggle(true)), true);
  assert.equal(isWebSearchEnabled(webSearchModeForToggle(false)), false);
});

test("a new conversation starts with the switch off", () => {
  assert.equal(normalizeWebSearchMode(APP_DEFAULTS.defaultWebSearchMode), "off");
});
