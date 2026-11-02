import assert from "node:assert/strict";
import test from "node:test";

import { marketingSectionAvailability } from "../lib/marketingConsoleSections.ts";
import { parseExperimentConfig } from "../lib/marketingExperimentCore.ts";
import { buildExperimentsConsole } from "../lib/marketingExperimentView.ts";

const DAY = 86_400_000;
const start = Date.parse("2026-11-10T00:00:00Z");
const raw = (overrides = {}) =>
  JSON.stringify({
    version: 1,
    experimentId: "spring-hero",
    bundleId: "home-hero-v1",
    variantId: "b",
    locales: ["en", "ko"],
    variantRatio: 0.2,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 14 * DAY).toISOString(),
    preregistration: {
      hypothesis: "A plainer headline raises primary call-to-action clicks.",
      primaryMetric: "primary_cta_click",
      minExposuresPerArm: 500,
      stopRule: { relativeDropPercent: 30, afterExposuresPerArm: 100 },
    },
    status: "running",
    stoppedAt: null,
    ...overrides,
  });

const snapshot = (overrides = {}, counts) => {
  const configRaw = raw(overrides);
  return {
    configRaw,
    version: "2026-11-10T00:00:00.000Z",
    config: parseExperimentConfig(configRaw),
    counts: counts ?? {
      controlExposures: 0,
      controlConversions: 0,
      variantExposures: 0,
      variantConversions: 0,
    },
  };
};

test("the experiments section is a section of its own now, not a future-stage placeholder", () => {
  assert.deepEqual(marketingSectionAvailability(), { available: true });
});

test("with nothing stored the section has no row and offers every bundle", () => {
  const { rows, experiments } = buildExperimentsConsole(
    { configRaw: null, version: null, config: null, counts: null },
    new Date(start)
  );
  assert.deepEqual(rows, []);
  assert.equal(experiments.version, null);
  assert.equal(experiments.unreadable, false);
  assert.equal(experiments.hasRunning, false);
  assert.equal(experiments.spikePassed, true);
  assert.deepEqual(experiments.bundles, [
    { bundleId: "home-hero-v1", variantId: "b", locales: ["en", "ko"] },
  ]);
});

test("a stored row this build cannot read is reported as unreadable, never as an experiment", () => {
  const { rows, experiments } = buildExperimentsConsole(
    { configRaw: "{broken", version: "v1", config: null, counts: null },
    new Date(start)
  );
  assert.deepEqual(rows, []);
  assert.equal(experiments.unreadable, true);
  assert.equal(experiments.hasRunning, false);
});

test("the row says what visitors actually get, not only what is stored", () => {
  const at = (offset, overrides, counts) =>
    buildExperimentsConsole(snapshot(overrides, counts), new Date(start + offset));

  assert.equal(at(DAY).rows[0].state, "active");
  assert.equal(at(-1).rows[0].state, "not_started");
  // Past its end date and still stored as running: not served, but it still has to be stopped.
  const ended = at(15 * DAY);
  assert.equal(ended.rows[0].state, "ended");
  assert.equal(ended.rows[0].status, "running");
  assert.equal(ended.experiments.hasRunning, true);
  // The stop rule makes it inactive without any write.
  const ruled = at(DAY, {}, {
    controlExposures: 500,
    controlConversions: 100,
    variantExposures: 500,
    variantConversions: 10,
  });
  assert.equal(ruled.rows[0].state, "stop_rule");
  assert.equal(ruled.experiments.hasRunning, true);
  // A recorded trip keeps it inactive even when the counters have recovered.
  const tripped = buildExperimentsConsole(
    {
      ...snapshot({}, {
        controlExposures: 600,
        controlConversions: 60,
        variantExposures: 600,
        variantConversions: 60,
      }),
      tripped: true,
    },
    new Date(start + DAY)
  );
  assert.equal(tripped.rows[0].state, "stop_rule");
  // Stopped is a record and frees the section for another start.
  const stopped = at(2 * DAY, { status: "stopped", stoppedAt: new Date(start + DAY).toISOString() });
  assert.equal(stopped.rows[0].state, "stopped");
  assert.equal(stopped.experiments.hasRunning, false);
});

test("rates are percentages of exposures and the minimum sample is per arm", () => {
  const row = buildExperimentsConsole(
    snapshot({}, {
      controlExposures: 600,
      controlConversions: 60,
      variantExposures: 499,
      variantConversions: 100,
    }),
    new Date(start + DAY)
  ).rows[0];
  assert.equal(row.controlRatePercent, 10);
  assert.equal(row.variantRatePercent, 20.04);
  assert.equal(row.sampleReached, false);
  assert.equal(row.variantRatioPercent, 20);
  assert.equal(row.version, "2026-11-10T00:00:00.000Z");

  const reached = buildExperimentsConsole(
    snapshot({}, {
      controlExposures: 500,
      controlConversions: 0,
      variantExposures: 500,
      variantConversions: 0,
    }),
    new Date(start + DAY)
  ).rows[0];
  assert.equal(reached.sampleReached, true);
  assert.equal(reached.controlRatePercent, 0);
});

test("the row says not served when the switch is off or the kill switch is set, whatever the configuration says", () => {
  const running = snapshot();
  const at = new Date(start + DAY);
  assert.equal(buildExperimentsConsole(running, at).rows[0].state, "active");
  assert.equal(
    buildExperimentsConsole(running, at, { switchOn: false, killSwitch: false }).rows[0].state,
    "switch_off"
  );
  assert.equal(
    buildExperimentsConsole(running, at, { switchOn: true, killSwitch: true }).rows[0].state,
    "kill_switch"
  );
  // The kill switch is the stronger statement.
  assert.equal(
    buildExperimentsConsole(running, at, { switchOn: false, killSwitch: true }).rows[0].state,
    "kill_switch"
  );
  // A stored status is still reported as stored.
  assert.equal(
    buildExperimentsConsole(running, at, { switchOn: false, killSwitch: false }).rows[0].status,
    "running"
  );
});
