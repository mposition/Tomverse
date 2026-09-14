// When a polling admin panel may issue a request.
//
// The two panels that poll disagreed about this, and neither answer was
// written down. Provider health skipped a tick in a background tab;
// infrastructure did not, so a console left open kept querying every ten
// minutes with nobody reading it. Neither tracked an in-flight request, so a
// slow endpoint made the ticks stack -- and the responses then raced, with a
// late one overwriting newer data and an early `finally` clearing the spinner
// belonging to a request still open. Both silent.

import assert from "node:assert/strict";
import test from "node:test";
import { shouldIssueAdminPoll } from "../lib/adminPollTick.ts";

const visible = { documentVisible: true, inFlight: false };

test("a visible panel polls on its own timer", () => {
  assert.equal(shouldIssueAdminPoll({ ...visible, trigger: "interval" }), true);
});

test("a background tab is not polled on a timer", () => {
  assert.equal(
    shouldIssueAdminPoll({
      inFlight: false,
      documentVisible: false,
      trigger: "interval",
    }),
    false
  );
});

test("focus and console-wide refresh still reach a panel that was hidden", () => {
  // The `focus` handler is what brings a stale panel up to date the moment
  // somebody looks at it again, so it cannot be gated on the visibility the
  // browser has not finished updating.
  assert.equal(
    shouldIssueAdminPoll({
      inFlight: false,
      documentVisible: false,
      trigger: "event",
    }),
    true
  );
  assert.equal(
    shouldIssueAdminPoll({
      inFlight: false,
      documentVisible: false,
      trigger: "manual",
    }),
    true
  );
});

test("nothing issues a second request while one is open", () => {
  for (const trigger of ["interval", "manual", "event"]) {
    assert.equal(
      shouldIssueAdminPoll({ ...visible, inFlight: true, trigger }),
      false,
      trigger
    );
  }
});

test("in-flight outranks visibility, so the rules cannot combine into an overlap", () => {
  assert.equal(
    shouldIssueAdminPoll({
      inFlight: true,
      documentVisible: false,
      trigger: "manual",
    }),
    false
  );
});
