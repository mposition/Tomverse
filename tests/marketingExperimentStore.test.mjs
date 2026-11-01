import assert from "node:assert/strict";
import test from "node:test";

import { parseMarketingReportPayload } from "../lib/marketingAutomationSchema.ts";
import { MARKETING_EXPERIMENTS_KEY } from "../lib/marketingAutomationAccess.ts";
import { MARKETING_EXPERIMENT_CONFIG_KEY } from "../lib/marketingExperimentContract.ts";
import {
  experimentCounterKey,
  parseExperimentConfig,
} from "../lib/marketingExperimentCore.ts";
import {
  MarketingExperimentRefusedError,
  experimentResultPayloads,
  experimentStartBodySchema,
  experimentStopBodySchema,
  startMarketingExperiment,
  stopMarketingExperiment,
} from "../lib/marketingExperimentStore.ts";

const NOW = new Date("2026-11-10T01:00:00.000Z");

/** The few `appSetting` and `marketingReport` calls the store makes, in memory. */
const makeTx = (settings = {}) => {
  const rows = new Map(
    Object.entries(settings).map(([key, value]) => [
      key,
      { value, updatedAt: new Date("2026-11-01T00:00:00.000Z") },
    ])
  );
  let tick = 1;
  const touch = () => new Date(Date.UTC(2026, 10, 2, 0, 0, tick++));
  const reports = [];
  return {
    rows,
    reports,
    appSetting: {
      findUnique: async ({ where: { key } }) => {
        const row = rows.get(key);
        return row ? { value: row.value, updatedAt: row.updatedAt } : null;
      },
      count: async ({ where: { key } }) =>
        [...rows.keys()].filter((name) => name.startsWith(key.startsWith)).length,
      create: async ({ data: { key, value } }) => {
        if (rows.has(key)) throw new Error("unique constraint");
        rows.set(key, { value, updatedAt: touch() });
      },
      updateMany: async ({ where: { key, updatedAt }, data: { value } }) => {
        const row = rows.get(key);
        if (!row || row.updatedAt.getTime() !== updatedAt.getTime()) {
          return { count: 0 };
        }
        rows.set(key, { value, updatedAt: touch() });
        return { count: 1 };
      },
      findMany: async ({ where: { key } }) =>
        [...rows.entries()]
          .filter(([name]) => name.startsWith(key.startsWith))
          .map(([name, row]) => ({ key: name, value: row.value })),
    },
    marketingReport: {
      create: async ({ data }) => {
        const row = { id: `report-${reports.length + 1}`, ...data };
        reports.push(row);
        return row;
      },
    },
  };
};

const body = (overrides = {}) => ({
  experimentId: "spring-hero",
  bundleId: "home-hero-v1",
  variantId: "b",
  locales: ["en", "ko"],
  variantRatioPercent: 20,
  durationDays: 14,
  preregistration: {
    hypothesis: "A plainer headline raises primary call-to-action clicks.",
    primaryMetric: "primary_cta_click",
    minExposuresPerArm: 500,
    stopRule: { relativeDropPercent: 30, afterExposuresPerArm: 100 },
  },
  expectedVersion: null,
  ...overrides,
});

const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof MarketingExperimentRefusedError, String(error));
    return error;
  }
  assert.fail("expected a refusal");
};

const withKillSwitch = async (value, run) => {
  const before = process.env.MARKETING_AUTOMATION_KILL_SWITCH;
  process.env.MARKETING_AUTOMATION_KILL_SWITCH = value;
  try {
    await run();
  } finally {
    if (before === undefined) delete process.env.MARKETING_AUTOMATION_KILL_SWITCH;
    else process.env.MARKETING_AUTOMATION_KILL_SWITCH = before;
  }
};

const on = { [MARKETING_EXPERIMENTS_KEY]: "true" };

test("the request bodies are strict and bounded", () => {
  assert.equal(experimentStartBodySchema.safeParse(body()).success, true);
  for (const bad of [
    body({ variantRatioPercent: 0 }),
    body({ variantRatioPercent: 51 }),
    body({ variantRatioPercent: 12.5 }),
    body({ durationDays: 0 }),
    body({ durationDays: 57 }),
    body({ locales: [] }),
    body({ extra: "headline" }),
    body({ preregistration: undefined }),
  ]) {
    assert.equal(experimentStartBodySchema.safeParse(bad).success, false);
  }
  assert.equal(experimentStopBodySchema.safeParse({ expectedVersion: "v" }).success, true);
  assert.equal(experimentStopBodySchema.safeParse({}).success, false);
});

test("an experiment does not start while the switch is off, missing or the kill switch is set", async () => {
  for (const settings of [{}, { [MARKETING_EXPERIMENTS_KEY]: "false" }]) {
    const tx = makeTx(settings);
    const error = await refusal(startMarketingExperiment(tx, body(), NOW));
    assert.equal(error.code, "experiment_not_admitted");
    assert.match(error.message, /input_false:experimentsEnabled/);
    assert.equal(tx.rows.has(MARKETING_EXPERIMENT_CONFIG_KEY), false);
  }
  await withKillSwitch("1", async () => {
    const tx = makeTx(on);
    const error = await refusal(startMarketingExperiment(tx, body(), NOW));
    assert.equal(error.code, "experiment_not_admitted");
    assert.match(error.message, /kill_switch/);
    assert.equal(tx.rows.has(MARKETING_EXPERIMENT_CONFIG_KEY), false);
  });
});

test("starting stores the pre-registration and names, and no words", async () => {
  const tx = makeTx(on);
  const started = await startMarketingExperiment(tx, body(), NOW);
  assert.equal(started.config.status, "running");
  assert.equal(started.config.variantRatio, 0.2);
  assert.equal(started.config.startsAt, NOW.toISOString());
  assert.equal(
    started.config.endsAt,
    new Date(NOW.getTime() + 14 * 86_400_000).toISOString()
  );

  const stored = tx.rows.get(MARKETING_EXPERIMENT_CONFIG_KEY).value;
  assert.deepEqual(parseExperimentConfig(stored), started.config);
  const keys = Object.keys(JSON.parse(stored));
  for (const forbidden of ["title", "headline", "body", "cta", "copy"]) {
    assert.ok(!keys.includes(forbidden), `the setting carries ${forbidden}`);
  }
  assert.equal(started.version, tx.rows.get(MARKETING_EXPERIMENT_CONFIG_KEY).updatedAt.toISOString());
});

test("a start is refused for anything the build or the schema does not stand behind", async () => {
  for (const [overrides, code] of [
    [{ bundleId: "home-unknown-v9" }, "experiment_config_invalid"],
    [{ variantId: "zz" }, "experiment_config_invalid"],
    [{ locales: ["en", "fr"] }, "experiment_config_invalid"],
    [{ variantRatioPercent: 60 }, "experiment_config_invalid"],
    [{ bundleId: "pricing-hero-v1" }, "experiment_config_invalid"],
  ]) {
    const tx = makeTx(on);
    const error = await refusal(startMarketingExperiment(tx, body(overrides), NOW));
    assert.equal(error.code, code, JSON.stringify(overrides));
    assert.equal(tx.rows.has(MARKETING_EXPERIMENT_CONFIG_KEY), false);
  }
});

test("a start against a stale screen, a running experiment or a used id is refused", async () => {
  const tx = makeTx(on);
  await refusal(
    startMarketingExperiment(tx, body({ expectedVersion: "2026-01-01T00:00:00.000Z" }), NOW)
  ).then((error) => assert.equal(error.code, "experiment_conflict"));

  const started = await startMarketingExperiment(tx, body(), NOW);
  const running = await refusal(
    startMarketingExperiment(
      tx,
      body({ experimentId: "second-run", expectedVersion: started.version }),
      NOW
    )
  );
  assert.equal(running.code, "experiment_running");

  const stopped = await stopMarketingExperiment(tx, { expectedVersion: started.version }, NOW);
  assert.equal(stopped.reportIds.length, 2);
  const afterStop = tx.rows.get(MARKETING_EXPERIMENT_CONFIG_KEY).updatedAt.toISOString();

  const reused = await refusal(
    startMarketingExperiment(tx, body({ expectedVersion: afterStop }), NOW)
  );
  assert.equal(reused.code, "experiment_id_used");

  const next = await startMarketingExperiment(
    tx,
    body({ experimentId: "second-run", expectedVersion: afterStop }),
    NOW
  );
  assert.equal(next.config.experimentId, "second-run");

  // Counters from an earlier run of the same id also make it unusable.
  const counted = makeTx({
    ...on,
    [experimentCounterKey("spring-hero", "control", "exposure")]: "3",
  });
  const leftover = await refusal(startMarketingExperiment(counted, body(), NOW));
  assert.equal(leftover.code, "experiment_id_used");
});

test("stopping writes one valid experiment_result report per arm, at the counters' figures", async () => {
  const tx = makeTx({
    ...on,
    [experimentCounterKey("spring-hero", "control", "exposure")]: "600",
    [experimentCounterKey("spring-hero", "control", "conversion")]: "60",
    [experimentCounterKey("spring-hero", "b", "exposure")]: "150",
    [experimentCounterKey("spring-hero", "b", "conversion")]: "21",
    [experimentCounterKey("other-run", "b", "exposure")]: "9999",
  });
  // The leftover-counter rule blocks a start, so seed the configuration directly.
  const started = makeTx(on);
  const config = (await startMarketingExperiment(started, body(), NOW)).config;
  tx.rows.set(MARKETING_EXPERIMENT_CONFIG_KEY, {
    value: JSON.stringify(config),
    updatedAt: new Date("2026-11-02T00:00:00.000Z"),
  });

  const later = new Date("2026-11-12T00:00:00.000Z");
  const result = await stopMarketingExperiment(
    tx,
    { expectedVersion: "2026-11-02T00:00:00.000Z" },
    later
  );
  assert.deepEqual(result.counts, {
    controlExposures: 600,
    controlConversions: 60,
    variantExposures: 150,
    variantConversions: 21,
  });
  assert.equal(tx.reports.length, 2);
  for (const report of tx.reports) {
    assert.equal(report.kind, "experiment_result");
    assert.equal(report.sourceVersion, "marketing-experiment-counters-v1");
    // The store's own schema is the judge of the payload.
    parseMarketingReportPayload("experiment_result", report.payload);
    assert.equal(report.payload.experimentId, "spring-hero");
  }
  assert.deepEqual(
    tx.reports.map((report) => [report.payload.variantId, report.payload.exposures, report.payload.conversions]),
    [
      ["control", 600, 60],
      ["b", 150, 21],
    ]
  );
  assert.equal(tx.reports[0].periodStart.toISOString(), NOW.toISOString());
  assert.equal(tx.reports[0].periodEnd.toISOString(), later.toISOString());

  const stored = parseExperimentConfig(tx.rows.get(MARKETING_EXPERIMENT_CONFIG_KEY).value);
  assert.equal(stored.status, "stopped");
  assert.equal(stored.stoppedAt, later.toISOString());
});

test("a stop is refused against a stale screen or when nothing is running", async () => {
  const tx = makeTx(on);
  const started = await startMarketingExperiment(tx, body(), NOW);
  await refusal(
    stopMarketingExperiment(tx, { expectedVersion: "2026-01-01T00:00:00.000Z" }, NOW)
  ).then((error) => assert.equal(error.code, "experiment_conflict"));
  assert.equal(tx.reports.length, 0);

  await stopMarketingExperiment(tx, { expectedVersion: started.version }, NOW);
  const current = tx.rows.get(MARKETING_EXPERIMENT_CONFIG_KEY).updatedAt.toISOString();
  await refusal(stopMarketingExperiment(tx, { expectedVersion: current }, NOW)).then(
    (error) => assert.equal(error.code, "experiment_not_running")
  );
  assert.equal(tx.reports.length, 2);

  await refusal(stopMarketingExperiment(makeTx(on), { expectedVersion: "v" }, NOW)).then(
    (error) => assert.equal(error.code, "experiment_conflict")
  );
});

test("a stop is never gated on the switch: it works with the switch off and under the kill switch", async () => {
  const tx = makeTx(on);
  const started = await startMarketingExperiment(tx, body(), NOW);
  tx.rows.delete(MARKETING_EXPERIMENTS_KEY);
  await withKillSwitch("1", async () => {
    const result = await stopMarketingExperiment(tx, { expectedVersion: started.version }, NOW);
    assert.equal(result.reportIds.length, 2);
  });
});

test("the report payloads keep the period well-ordered even when the stop precedes the start", () => {
  const config = {
    experimentId: "spring-hero",
    variantId: "b",
    startsAt: "2026-11-10T00:00:00.000Z",
  };
  const [control] = experimentResultPayloads(
    config,
    { controlExposures: 0, controlConversions: 0, variantExposures: 0, variantConversions: 0 },
    new Date("2026-11-09T00:00:00.000Z")
  );
  assert.equal(control.endedAt, config.startsAt);
});

test("an id stays used after later runs replace the stored configuration", async () => {
  const tx = makeTx(on);
  const versionOf = () => tx.rows.get(MARKETING_EXPERIMENT_CONFIG_KEY).updatedAt.toISOString();

  // Run A, stopped without a single count: no counter rows exist for it.
  const a = await startMarketingExperiment(tx, body(), NOW);
  await stopMarketingExperiment(tx, { expectedVersion: a.version }, NOW);
  assert.ok(tx.rows.has("marketingAutomation.experimentUsed.spring-hero"));

  // Run B overwrites the stored configuration and is stopped too.
  const b = await startMarketingExperiment(
    tx,
    body({ experimentId: "second-run", expectedVersion: versionOf() }),
    NOW
  );
  await stopMarketingExperiment(tx, { expectedVersion: b.version }, NOW);

  // A's configuration is gone and it left no counters, yet A cannot start again:
  // a cookie from its first run would otherwise count as an assignment in this one.
  const again = await refusal(
    startMarketingExperiment(tx, body({ expectedVersion: versionOf() }), NOW)
  );
  assert.equal(again.code, "experiment_id_used");
  assert.equal(
    [...tx.rows.keys()].filter((key) => key.startsWith("marketingAutomation.experimentUsed.")).length,
    2
  );
});
