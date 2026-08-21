import assert from "node:assert/strict";
import test from "node:test";

import {
  SEARCH_PATH_GAPS,
  hasSearchPath,
  resolveAttemptSearchPath,
} from "../lib/webSearchPath.ts";

/**
 * "Allowed to search" and "will search" are different facts, and only the
 * first one was ever checked.
 *
 * The Router's candidate filter keeps a native model for a turn that needs
 * current information because the register says it can search. Whether it
 * actually does depends on the web search mode, on a tool configuration being
 * built, and on the surcharge being reserved -- none of which the filter can
 * see, because it runs before there is an attempt to configure or a cost to
 * reserve. This is the second check.
 */

const path = (overrides = {}) =>
  resolveAttemptSearchPath({
    support: "native",
    webSearchMode: "always",
    toolConfigBuilt: true,
    surchargeCredits: 8,
    ...overrides,
  });

test("a search model searches without anything else being arranged", () => {
  // Perplexity searches as part of ordinary completion: no tool, no mode, no
  // surcharge -- its base weight already carries the cost.
  for (const webSearchMode of ["always", "auto", "off", null]) {
    const resolved = path({
      support: "search-model",
      webSearchMode,
      toolConfigBuilt: false,
      surchargeCredits: 0,
    });
    assert.deepEqual(resolved, { kind: "search_model" }, String(webSearchMode));
    assert.equal(hasSearchPath(resolved), true);
  }
});

test("a native model searches only when this turn actually enabled the tool", () => {
  assert.deepEqual(path(), { kind: "native_tool" });
  assert.equal(hasSearchPath(path()), true);
});

// The gap the Router could not see: the filter admitted this model *because*
// it can search, and on this turn it will not.
test("a native model in auto or off mode has no search path", () => {
  for (const webSearchMode of ["auto", "off", null]) {
    assert.deepEqual(
      path({ webSearchMode, toolConfigBuilt: false, surchargeCredits: 0 }),
      { kind: "none", gap: "mode_not_always" },
      String(webSearchMode)
    );
  }
});

test("a model that cannot search, and one nobody confirmed, are told apart", () => {
  // Unverified is not a maybe -- the same reading the candidate filter gives
  // it -- but it is a different operational fact from unsupported, and one
  // reason for both would hide which register entry needs the work.
  assert.deepEqual(path({ support: "unsupported" }), {
    kind: "none",
    gap: "capability_unsupported",
  });
  assert.deepEqual(path({ support: "unverified" }), {
    kind: "none",
    gap: "capability_unverified",
  });
});

test("a native tool that could not be built is its own failure, not a mode problem", () => {
  // The register and the tool builder disagreeing about a provider is a
  // defect. Folded into "the mode was wrong" it would look like ordinary
  // configuration and never be fixed.
  assert.deepEqual(path({ toolConfigBuilt: false }), {
    kind: "none",
    gap: "tool_config_unavailable",
  });
});

test("a native tool with no surcharge behind it does not count as a path", () => {
  // The reservation is what pays for the search. Configured without one, this
  // is either an unbilled search or a tool that will not run.
  assert.deepEqual(path({ surchargeCredits: 0 }), {
    kind: "none",
    gap: "surcharge_unreserved",
  });
});

test("every gap is one of the declared identifiers", () => {
  const cases = [
    { support: "unsupported" },
    { support: "unverified" },
    { webSearchMode: "off" },
    { toolConfigBuilt: false },
    { surchargeCredits: 0 },
  ];
  for (const override of cases) {
    const resolved = path(override);
    assert.equal(resolved.kind, "none", JSON.stringify(override));
    assert.ok(SEARCH_PATH_GAPS.includes(resolved.gap), resolved.gap);
  }
});

test("the answer carries no request content", () => {
  assert.ok(!JSON.stringify(path({ support: "unsupported" })).includes("http"));
  // Fixed identifiers only: a gap is a name from this module, never anything
  // read off the turn.
  assert.deepEqual(Object.keys(path({ support: "unsupported" })).sort(), [
    "gap",
    "kind",
  ]);
});
