import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  MIN_SAMPLES_PER_MODEL,
  MIN_WINDOW_DAYS,
  reportModelOutputTokens,
  summarise,
  type OutputTokenSample,
} from "@/lib/outputTokenTelemetryCore";

const day = (index: number) =>
  new Date(Date.UTC(2026, 6, 1) + index * 86_400_000).toISOString();

const sample = (
  overrides: Partial<OutputTokenSample> & { outputTokens: number }
): OutputTokenSample => ({
  modelId: "gpt-5-6-luna",
  settledAt: day(0),
  workload: "chat",
  reasoningEffort: "medium",
  billed: true,
  partial: false,
  usageSource: "provider_reported",
  ...overrides,
});

/** A sample large and wide enough to clear every measurable condition. */
const healthySamples = (count = MIN_SAMPLES_PER_MODEL) =>
  Array.from({ length: count }, (_, index) =>
    sample({
      outputTokens: 200 + (index % 400),
      settledAt: day((index % (MIN_WINDOW_DAYS + 6)) * 1),
    })
  );

const conditionFor = (
  report: ReturnType<typeof reportModelOutputTokens>,
  code: string
) => report.conditions.find((condition) => condition.code === code);

test("percentiles come out in order and handle an empty sample", () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  const stats = summarise(values);
  assert.equal(stats.count, 100);
  assert.equal(stats.p50, 50);
  assert.equal(stats.p90, 90);
  assert.equal(stats.p95, 95);
  assert.equal(stats.p99, 99);
  assert.equal(stats.max, 100);

  assert.deepEqual(summarise([]), {
    count: 0,
    p50: 0,
    p90: 0,
    p95: 0,
    p99: 0,
    max: 0,
  });
});

test("only the named model's own answers are counted", () => {
  // Policy 3.1(1). Two models' output distributions are not each other's
  // evidence, so this is enforced by construction rather than checked after.
  const report = reportModelOutputTokens({
    modelId: "gpt-5-6-luna",
    samples: [
      sample({ outputTokens: 100 }),
      sample({ outputTokens: 100_000, modelId: "gpt-5-4-mini" }),
    ],
  });
  assert.equal(report.overall.count, 1);
  assert.equal(report.overall.max, 100);
  assert.equal(conditionFor(report, "per_model")?.satisfied, true);
});

test("too few samples, or too short a window, blocks the sample-size condition", () => {
  const small = reportModelOutputTokens({
    modelId: "gpt-5-6-luna",
    samples: healthySamples(10),
  });
  assert.equal(conditionFor(small, "window_and_sample_size")?.satisfied, false);

  const narrow = reportModelOutputTokens({
    modelId: "gpt-5-6-luna",
    samples: Array.from({ length: MIN_SAMPLES_PER_MODEL }, (_, index) =>
      sample({ outputTokens: 300, settledAt: day(index % 3) })
    ),
  });
  assert.equal(conditionFor(narrow, "window_and_sample_size")?.satisfied, false);

  const healthy = reportModelOutputTokens({
    modelId: "gpt-5-6-luna",
    samples: healthySamples(),
  });
  assert.equal(conditionFor(healthy, "window_and_sample_size")?.satisfied, true);
});

test("a workload with a far heavier tail is reported, not averaged away", () => {
  // Policy 3.1(3): if one workload's p90 sits well above the overall p90, the
  // overall figure does not cover it and must not be used as if it did.
  const report = reportModelOutputTokens({
    modelId: "gpt-5-6-luna",
    samples: [
      ...healthySamples(),
      ...Array.from({ length: 40 }, (_, index) =>
        sample({
          outputTokens: 30_000,
          workload: "comparison-review",
          settledAt: day(index % MIN_WINDOW_DAYS),
        })
      ),
    ],
  });
  const condition = conditionFor(report, "workload_split");
  assert.equal(condition?.satisfied, false);
  assert.match(condition?.detail ?? "", /comparison-review/);
});

test("estimated usage cannot size a reservation", () => {
  const report = reportModelOutputTokens({
    modelId: "gpt-5-6-luna",
    samples: [
      ...healthySamples(),
      sample({ outputTokens: 300, usageSource: "estimated" }),
    ],
  });
  assert.equal(conditionFor(report, "settled_tokens_only")?.satisfied, false);
});

test("unbilled answers are excluded and billed partial ones are kept", () => {
  // Policy 3.1(5). A cancelled answer still had a reservation taken for it,
  // so dropping it would understate the tail; a failure that cost nothing had
  // no cost to size.
  const report = reportModelOutputTokens({
    modelId: "gpt-5-6-luna",
    samples: [
      sample({ outputTokens: 500, partial: true }),
      sample({ outputTokens: 999_999, billed: false }),
    ],
  });
  assert.equal(report.overall.count, 1);
  assert.equal(report.overall.max, 500);
  assert.equal(report.partialShare, 1);
});

test("mixing reasoning settings fails the homogeneity condition", () => {
  const report = reportModelOutputTokens({
    modelId: "gpt-5-6-luna",
    samples: [
      ...healthySamples(),
      sample({ outputTokens: 400, reasoningEffort: "low" }),
    ],
  });
  assert.equal(
    conditionFor(report, "homogeneous_configuration")?.satisfied,
    false
  );
});

test("three conditions are left to a human and are never auto-satisfied", () => {
  const report = reportModelOutputTokens({
    modelId: "gpt-5-6-luna",
    samples: healthySamples(),
  });
  for (const code of ["auditable_record", "headroom_and_floor", "drift_watch"]) {
    assert.equal(conditionFor(report, code)?.satisfied, null, code);
  }
});

test("the basis stays conservative_default even on a flawless sample", () => {
  // The whole module's contract. A passing checklist is an input to a
  // decision, not the decision -- and applying a p90 needs a new
  // pricingVersion so reservations sized two different ways are never mixed.
  const report = reportModelOutputTokens({
    modelId: "gpt-5-6-luna",
    samples: healthySamples(),
  });
  assert.deepEqual(report.blockers, []);
  assert.equal(report.recommendedBasis, "conservative_default");
});

test("the reporting script is read-only", () => {
  const source = readFileSync(
    join(process.cwd(), "scripts/report-output-token-telemetry.mjs"),
    "utf8"
  );
  for (const write of [
    ".update(",
    ".updateMany(",
    ".create(",
    ".createMany(",
    ".upsert(",
    ".delete(",
    ".deleteMany(",
    "$executeRaw",
  ]) {
    assert.equal(
      source.includes(write),
      false,
      `the telemetry report must not call ${write}`
    );
  }
  assert.match(source, /p90_output_tokens|conservative_default/);
});
