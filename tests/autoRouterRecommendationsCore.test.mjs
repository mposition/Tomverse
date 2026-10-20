import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  RECOMMENDATION_FILE_HINTS,
  RECOMMENDATION_STATUSES,
  actionableRecommendations,
  buildRecommendationInstruction,
  copyToClipboard,
  openRecommendations,
  recommendationStatusEntries,
  reportFindings,
  withRecommendationStatus,
} from "../lib/autoRouterRecommendationsCore.ts";
import { adminAutoRouterOptimizerMessages } from "../lib/adminMessages/autoRouterOptimizer.ts";

const report = {
  findings: ["answer calls failed for two models", "most picks agreed with the rule"],
  recommendations: [
    { kind: "guidance", text: "Send translation to the light model." },
    { kind: "code", text: "Trace the failing answer calls and retry on a same-credit model." },
    { kind: "setting", text: "Exclude the repeatedly failing model for a day." },
    { kind: "code", text: "Log the router timeout rate." },
  ],
};

test("only code and setting recommendations are actionable, keeping their place in the report", () => {
  const items = actionableRecommendations({ report });
  assert.deepEqual(
    items.map((item) => [item.index, item.kind, item.status]),
    [
      [1, "code", "open"],
      [2, "setting", "open"],
      [3, "code", "open"],
    ]
  );
  assert.equal(items[0].text, report.recommendations[1].text);
});

test("a cycle with no report, or a malformed one, has nothing to act on", () => {
  for (const summary of [null, undefined, {}, { report: null }, { report: { recommendations: "x" } }, []]) {
    assert.deepEqual(actionableRecommendations(summary), []);
    assert.deepEqual(reportFindings(summary), []);
  }
  assert.deepEqual(
    actionableRecommendations({
      report: { recommendations: [null, { kind: "code" }, { kind: "other", text: "x" }, { kind: "code", text: "ok" }] },
    }).map((item) => item.index),
    [3]
  );
});

test("a stored status is read back, and a malformed entry reads as open", () => {
  const summary = {
    report,
    recommendationStatus: {
      1: { status: "done", at: "2026-10-20T01:00:00.000Z", by: "owner-1" },
      2: { status: "bogus", at: "2026-10-20T01:00:00.000Z", by: "owner-1" },
      3: { status: "dismissed", by: "owner-1" },
      x: { status: "done", at: "2026-10-20T01:00:00.000Z", by: "owner-1" },
    },
  };
  assert.deepEqual([...recommendationStatusEntries(summary).keys()], [1]);
  assert.deepEqual(
    actionableRecommendations(summary).map((item) => [item.index, item.status, item.by]),
    [
      [1, "done", "owner-1"],
      [2, "open", null],
      [3, "open", null],
    ]
  );
});

test("setting one status keeps every other field and entry, and does not mutate its input", () => {
  const summary = {
    evaluated: 12,
    report,
    recommendationStatus: { 1: { status: "done", at: "a", by: "u1" } },
  };
  const before = JSON.stringify(summary);
  const next = withRecommendationStatus(summary, 3, { status: "dismissed", at: "b", by: "u2" });
  assert.equal(JSON.stringify(summary), before);
  assert.equal(next.evaluated, 12);
  assert.deepEqual(next.report, report);
  assert.deepEqual(next.recommendationStatus, {
    1: { status: "done", at: "a", by: "u1" },
    3: { status: "dismissed", at: "b", by: "u2" },
  });
  // A summary with no status map yet gets one.
  assert.deepEqual(withRecommendationStatus({ report }, 1, { status: "open", at: "c", by: "u3" }).recommendationStatus, {
    1: { status: "open", at: "c", by: "u3" },
  });
  // The statuses an operator can set are exactly the three the route accepts.
  assert.deepEqual([...RECOMMENDATION_STATUSES], ["open", "done", "dismissed"]);
});

test("open recommendations run newest cycle first and drop the ones already handled", () => {
  const cycles = [
    {
      id: "old",
      createdAt: "2026-10-18T00:00:00.000Z",
      summary: { report, recommendationStatus: { 1: { status: "done", at: "a", by: "u" } } },
    },
    { id: "new", createdAt: "2026-10-20T00:00:00.000Z", summary: { report } },
    { id: "empty", createdAt: "2026-10-19T00:00:00.000Z", summary: null },
    {
      id: "mid",
      createdAt: "2026-10-19T12:00:00.000Z",
      summary: { report, recommendationStatus: { 2: { status: "dismissed", at: "a", by: "u" } } },
    },
  ];
  assert.deepEqual(
    openRecommendations(cycles).map((item) => `${item.cycleId}:${item.index}`),
    ["new:1", "new:2", "new:3", "mid:1", "mid:3", "old:2", "old:3"]
  );
});

const labels = adminAutoRouterOptimizerMessages.en.instruction;
const cycle = { id: "cyc_1", createdAt: "2026-10-20T01:02:03.000Z" };
const link = "https://tomverse.test/admin/routing#optimizer-cycle-cyc_1";

test("the instruction carries the recommendation, findings, cycle, link, file hints and the closing line", () => {
  const text = buildRecommendationInstruction({
    labels,
    recommendation: { kind: "code", text: report.recommendations[1].text },
    findings: reportFindings({ report }),
    cycle,
    link,
  });
  for (const part of [
    report.recommendations[1].text,
    ...report.findings,
    cycle.id,
    cycle.createdAt,
    link,
    ...RECOMMENDATION_FILE_HINTS.code,
    labels.closing,
  ]) {
    assert.ok(text.includes(part), `missing: ${part}`);
  }
  assert.ok(!text.includes(RECOMMENDATION_FILE_HINTS.setting[0]));
  // Deterministic: the same inputs give the same text.
  assert.equal(
    text,
    buildRecommendationInstruction({
      labels,
      recommendation: { kind: "code", text: report.recommendations[1].text },
      findings: reportFindings({ report }),
      cycle,
      link,
    })
  );
});

test("a cycle with no findings says so, and the Korean labels build the same shape", () => {
  const ko = adminAutoRouterOptimizerMessages.ko.instruction;
  const text = buildRecommendationInstruction({
    labels: ko,
    recommendation: { kind: "setting", text: "설정 권장안" },
    findings: [],
    cycle,
    link,
  });
  assert.ok(text.includes(ko.noFindings));
  assert.ok(text.includes(ko.closing));
  assert.ok(text.includes(RECOMMENDATION_FILE_HINTS.setting[0]));
});

test("every file hint names something that exists in the repository", () => {
  const root = join(import.meta.dirname, "..");
  const matches = (hint) => {
    if (!hint.includes("*")) return existsSync(join(root, hint));
    if (hint.endsWith("/route.ts") && hint.includes("**")) {
      return existsSync(join(root, hint.split("/**")[0]));
    }
    const directory = join(root, dirname(hint));
    const [prefix, suffix] = hint.slice(dirname(hint).length + 1).split("*");
    return readdirSync(directory).some((name) => name.startsWith(prefix) && name.endsWith(suffix));
  };
  for (const hints of Object.values(RECOMMENDATION_FILE_HINTS)) {
    for (const hint of hints) assert.ok(matches(hint), `no file for hint ${hint}`);
  }
});

test("copying reports a refused or missing clipboard so the text can be shown for manual copy", async () => {
  const written = [];
  assert.equal(await copyToClipboard({ writeText: async (text) => void written.push(text) }, "abc"), "copied");
  assert.deepEqual(written, ["abc"]);
  assert.equal(
    await copyToClipboard({ writeText: async () => Promise.reject(new Error("NotAllowedError")) }, "abc"),
    "manual"
  );
  assert.equal(
    await copyToClipboard({ writeText: () => { throw new Error("sync failure"); } }, "abc"),
    "manual"
  );
  assert.equal(await copyToClipboard(undefined, "abc"), "manual");
});
