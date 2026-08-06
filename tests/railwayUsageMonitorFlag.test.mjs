import assert from "node:assert/strict";
import test from "node:test";

import {
  RAILWAY_USAGE_MONITOR_FLAG_ENV,
  railwayUsageMonitorEnabled,
  railwayUsageMonitorEnabledFromValue,
} from "../lib/railwayUsageMonitorFlag.ts";

// The regression this guards: production and staging share one Railway
// Project-Access-Token, so both `estimatedUsage` queries ran together and hit
// Railway's per-client concurrent usage-query limit. The switch that separates
// them must be default-on, so an environment that never sets the variable --
// production -- keeps its historical behaviour.

test("a missing, empty or blank value keeps usage monitoring enabled", () => {
  for (const value of [undefined, null, "", "   ", "\t\n"]) {
    assert.equal(railwayUsageMonitorEnabledFromValue(value), true);
  }
});

test("only the literal false disables usage monitoring", () => {
  for (const value of ["false", "FALSE", "False", " false ", "\tFaLsE\n"]) {
    assert.equal(railwayUsageMonitorEnabledFromValue(value), false);
  }
});

test("true and unknown values keep the enabled behaviour", () => {
  for (const value of [
    "true",
    "TRUE",
    " true ",
    "0",
    "off",
    "no",
    "disabled",
    "falsey",
    "false false",
  ]) {
    assert.equal(railwayUsageMonitorEnabledFromValue(value), true, value);
  }
});

test("the environment reader is bound to RAILWAY_USAGE_MONITOR_ENABLED", () => {
  assert.equal(RAILWAY_USAGE_MONITOR_FLAG_ENV, "RAILWAY_USAGE_MONITOR_ENABLED");
  assert.equal(railwayUsageMonitorEnabled({}), true);
  assert.equal(
    railwayUsageMonitorEnabled({ RAILWAY_USAGE_MONITOR_ENABLED: "false" }),
    false
  );
  assert.equal(
    railwayUsageMonitorEnabled({ RAILWAY_USAGE_MONITOR_ENABLED: "true" }),
    true
  );
  // Neighbouring Railway variables keep their own meaning: the switch reads
  // exactly one name and never infers the environment from another.
  assert.equal(
    railwayUsageMonitorEnabled({
      RAILWAY_ENVIRONMENT_NAME: "staging",
      NODE_ENV: "production",
      RAILWAY_PROJECT_TOKEN: "token",
    }),
    true
  );
});
