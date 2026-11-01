import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  EXPERIMENT_MAX_DURATION_DAYS,
  MARKETING_EXPERIMENT_SPIKE,
  experimentConfigSchema,
} from "../lib/marketingExperimentContract.ts";
import { EXPERIMENT_CONTROL_ARM } from "../lib/marketingRoutes.ts";
import {
  EMPTY_EXPERIMENT_COUNTS,
  experimentAnalyticsActive,
  experimentCookieMaxAgeSeconds,
  experimentCounterKey,
  experimentCountsFromRows,
  experimentRates,
  experimentStopRuleTriggered,
  parseExperimentConfig,
  pickExperimentArm,
  resolveActiveExperiment,
} from "../lib/marketingExperimentCore.ts";

const DAY = 86_400_000;
const start = Date.parse("2026-11-10T00:00:00Z");
const config = (overrides = {}) => ({
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

const issues = (value) => {
  const result = experimentConfigSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

test("a complete, pre-registered configuration parses", () => {
  assert.deepEqual(issues(config()), []);
});

test("the share is above zero and at most half", () => {
  assert.deepEqual(issues(config({ variantRatio: 0.5 })), []);
  for (const variantRatio of [0, -0.1, 0.51, 1, Number.NaN]) {
    assert.notDeepEqual(issues(config({ variantRatio })), [], String(variantRatio));
  }
});

test("the run is fixed in time and bounded", () => {
  assert.notDeepEqual(
    issues(config({ endsAt: new Date(start).toISOString() })),
    []
  );
  assert.notDeepEqual(
    issues(config({ endsAt: new Date(start - DAY).toISOString() })),
    []
  );
  assert.deepEqual(
    issues(
      config({
        endsAt: new Date(start + EXPERIMENT_MAX_DURATION_DAYS * DAY).toISOString(),
      })
    ),
    []
  );
  assert.notDeepEqual(
    issues(
      config({
        endsAt: new Date(
          start + (EXPERIMENT_MAX_DURATION_DAYS + 1) * DAY
        ).toISOString(),
      })
    ),
    []
  );
});

test("nothing starts without a full pre-registration", () => {
  const pre = config().preregistration;
  for (const broken of [
    { ...pre, hypothesis: "short" },
    { ...pre, primaryMetric: "revenue" },
    { ...pre, minExposuresPerArm: 10 },
    { ...pre, stopRule: undefined },
    { ...pre, stopRule: { relativeDropPercent: 1, afterExposuresPerArm: 100 } },
    { ...pre, stopRule: { relativeDropPercent: 30 } },
  ]) {
    assert.notDeepEqual(issues(config({ preregistration: broken })), []);
  }
  const { preregistration, ...without } = config();
  assert.ok(preregistration);
  assert.notDeepEqual(issues(without), []);
  // No words in the setting: an extra key is refused, not stored.
  assert.notDeepEqual(issues(config({ headline: "Buy now" })), []);
});

test("only home bundles whose variant has copy for every listed locale can be activated", () => {
  assert.notDeepEqual(issues(config({ bundleId: "pricing-hero-v1" })), []);
  assert.notDeepEqual(issues(config({ variantId: "control" })), []);
  // The shipped example bundle has English and Korean copy only.
  assert.notDeepEqual(issues(config({ locales: ["en", "fr"] })), []);
  assert.notDeepEqual(issues(config({ locales: [] })), []);
  assert.notDeepEqual(issues(config({ variantId: "zz" })), []);
});

test("an unreadable stored value is no configuration", () => {
  assert.equal(parseExperimentConfig(null), null);
  assert.equal(parseExperimentConfig(""), null);
  assert.equal(parseExperimentConfig("{not json"), null);
  assert.equal(parseExperimentConfig(JSON.stringify({ ...config(), version: 2 })), null);
  assert.deepEqual(parseExperimentConfig(JSON.stringify(config())), config());
});

const counts = (controlExposures, controlConversions, variantExposures, variantConversions) => ({
  controlExposures,
  controlConversions,
  variantExposures,
  variantConversions,
});

test("counters read back from rows, and a malformed row is zero rather than a guess", () => {
  const rows = new Map([
    [experimentCounterKey("spring-hero", "control", "exposure"), "120"],
    [experimentCounterKey("spring-hero", "control", "conversion"), "12"],
    [experimentCounterKey("spring-hero", "b", "exposure"), "-3"],
    [experimentCounterKey("spring-hero", "b", "conversion"), "abc"],
    [experimentCounterKey("other-run", "b", "exposure"), "999"],
  ]);
  assert.deepEqual(
    experimentCountsFromRows({ experimentId: "spring-hero", variantId: "b" }, rows),
    counts(120, 12, 0, 0)
  );
  assert.deepEqual(experimentRates(counts(100, 10, 0, 0)), { control: 0.1, variant: null });
});

test("the stop rule needs both arms to have enough exposures and a real drop", () => {
  const { preregistration } = config();
  // Not enough exposures in one arm.
  assert.equal(experimentStopRuleTriggered(preregistration, counts(500, 100, 99, 0)), false);
  // Enough exposures, variant at 8% against control at 20%: a 60% relative drop.
  assert.equal(experimentStopRuleTriggered(preregistration, counts(500, 100, 500, 40)), true);
  // A 25% drop is under the 30% line.
  assert.equal(experimentStopRuleTriggered(preregistration, counts(500, 100, 500, 75)), false);
  // The exact line counts.
  assert.equal(experimentStopRuleTriggered(preregistration, counts(500, 100, 500, 70)), true);
  // A control that never converted gives nothing to drop from.
  assert.equal(experimentStopRuleTriggered(preregistration, counts(500, 0, 500, 0)), false);
  // A better variant never stops the run.
  assert.equal(experimentStopRuleTriggered(preregistration, counts(500, 50, 500, 90)), false);
});

test("an experiment is active only inside its window, while running, and until its stop rule fires", () => {
  const value = config();
  const at = (offsetMs) => new Date(start + offsetMs);
  assert.deepEqual(resolveActiveExperiment(value, EMPTY_EXPERIMENT_COUNTS, at(DAY)), {
    active: true,
    config: value,
  });
  assert.deepEqual(resolveActiveExperiment(value, EMPTY_EXPERIMENT_COUNTS, at(-1)), {
    active: false,
    reason: "not_started",
  });
  assert.deepEqual(resolveActiveExperiment(value, EMPTY_EXPERIMENT_COUNTS, at(14 * DAY)), {
    active: false,
    reason: "ended",
  });
  assert.deepEqual(
    resolveActiveExperiment(
      config({ status: "stopped", stoppedAt: at(DAY).toISOString() }),
      EMPTY_EXPERIMENT_COUNTS,
      at(2 * DAY)
    ),
    { active: false, reason: "stopped" }
  );
  assert.deepEqual(resolveActiveExperiment(value, counts(500, 100, 500, 10), at(DAY)), {
    active: false,
    reason: "stop_rule",
  });
});

test("the share decides the arm, and a roll equal to the share is the control", () => {
  const value = { variantId: "b", variantRatio: 0.2 };
  assert.equal(pickExperimentArm(value, 0), "b");
  assert.equal(pickExperimentArm(value, 0.1999), "b");
  assert.equal(pickExperimentArm(value, 0.2), "control");
  assert.equal(pickExperimentArm(value, 0.999999), "control");
  // Over a large fixed sweep the realised share stays at the configured one.
  let variant = 0;
  for (let index = 0; index < 100_000; index += 1) {
    if (pickExperimentArm(value, index / 100_000) === "b") variant += 1;
  }
  assert.equal(variant, 20_000);
});

test("analytics is on by the consent provider's own rule and by nothing else", () => {
  assert.equal(experimentAnalyticsActive("accepted", "opt_in"), true);
  assert.equal(experimentAnalyticsActive("accepted", "notice_opt_out"), true);
  assert.equal(experimentAnalyticsActive("unset", "notice_opt_out"), true);
  assert.equal(experimentAnalyticsActive("unset", "opt_in"), false);
  assert.equal(experimentAnalyticsActive("declined", "opt_in"), false);
  assert.equal(experimentAnalyticsActive("declined", "notice_opt_out"), false);
});

test("the assignment cookie never outlives the experiment", () => {
  const value = parseExperimentConfig(JSON.stringify(config()));
  assert.equal(experimentCookieMaxAgeSeconds(value, new Date(start)), 14 * 86_400);
  assert.equal(experimentCookieMaxAgeSeconds(value, new Date(start + 13 * DAY)), 86_400);
  assert.equal(experimentCookieMaxAgeSeconds(value, new Date(start + 20 * DAY)), 0);
});

test("the recorded spike points at a spec that exists", () => {
  assert.equal(MARKETING_EXPERIMENT_SPIKE.passed, true);
  assert.ok(
    existsSync(new URL(`../${MARKETING_EXPERIMENT_SPIKE.e2eSpec}`, import.meta.url)),
    "the spike's E2E spec is missing, so the record of it passing is unsupported"
  );
});

test("the contract module and the request boundary agree on the control arm's name", () => {
  // The contract module is kept free of local imports, so it spells the word
  // itself; the proxy's routing rules spell it too. They must stay one word.
  assert.equal(EXPERIMENT_CONTROL_ARM, "control");
  const bad = experimentConfigSchema.safeParse({
    version: 1,
    experimentId: "spring-hero",
    bundleId: "home-hero-v1",
    variantId: EXPERIMENT_CONTROL_ARM,
    locales: ["en"],
    variantRatio: 0.2,
    startsAt: "2026-11-10T00:00:00Z",
    endsAt: "2026-11-24T00:00:00Z",
    preregistration: {
      hypothesis: "A plainer headline raises primary call-to-action clicks.",
      primaryMetric: "primary_cta_click",
      minExposuresPerArm: 500,
      stopRule: { relativeDropPercent: 30, afterExposuresPerArm: 100 },
    },
    status: "running",
    stoppedAt: null,
  });
  assert.equal(bad.success, false);
});
