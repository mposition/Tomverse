import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTING_DISPATCH_INSTRUMENTATION_ENV,
  dispatchInstrumentationMode,
} from "../lib/routingInstrumentationMode.ts";

const withValue = (value) =>
  dispatchInstrumentationMode(
    value === undefined ? {} : { [ROUTING_DISPATCH_INSTRUMENTATION_ENV]: value }
  );

test("the two recording modes are recognised", () => {
  assert.equal(withValue("observe"), "observe");
  assert.equal(withValue("enforce"), "enforce");
});

test("unset is off", () => {
  assert.equal(withValue(undefined), "off");
  assert.equal(withValue(""), "off");
});

// The failure this shape prevents: somebody setting the variable to something
// that reads as "yes" and believing recording is on. An unrecognised value
// records nothing, which is what the variable being unset already does -- and
// the readiness report prints the resolved mode so the difference is visible
// rather than assumed.
test("anything that merely looks affirmative is off", () => {
  for (const value of ["true", "1", "on", "yes", "ON", "Observe", "enforce "]) {
    assert.equal(withValue(value), "off", value);
  }
});

test("the environment is a parameter, so nothing has to mutate process.env", () => {
  // A test that set the real variable would leak into every test file sharing
  // the process, and this runner shares one.
  assert.equal(
    dispatchInstrumentationMode({ [ROUTING_DISPATCH_INSTRUMENTATION_ENV]: "observe" }),
    "observe"
  );
  assert.equal(dispatchInstrumentationMode({}), "off");
});
