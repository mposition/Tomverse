// The operator's morning report (owner request 2026-11-03): the figures code
// counts, what the model is told, and what of its answer is kept.

import assert from "node:assert/strict";
import test from "node:test";

import {
  marketingBrisbaneDate,
  marketingMorningFigures,
  marketingMorningMessages,
  marketingMorningOperationsSchema,
  readMarketingMorningReport,
} from "@/lib/marketingMorningCore";

const OPERATIONS = marketingMorningOperationsSchema.parse({
  measurement: {
    dispatch: { sent: 2, published: 1, failed: 1 },
    queue: { pendingApproval: 9, approvedWaiting: 3, nextApprovalExpiryAt: null },
    touches: null,
    signups: null,
    llm: null,
  },
  switches: { publishEnabled: null },
});

test("the date is Brisbane's, and the figures come from the counts, unknowns kept unknown", () => {
  assert.equal(marketingBrisbaneDate(Date.parse("2026-11-03T21:00:00Z")), "2026-11-04");
  assert.deepEqual(marketingMorningFigures(OPERATIONS), {
    published7d: 1,
    sent7d: 2,
    failed7d: 1,
    pendingApproval: 9,
    approvedWaiting: 3,
    nextApprovalExpiryAt: null,
    touches7d: null,
    signupsAttributed7d: null,
    llmCountedMicroUsd: null,
    llmCapUsd: null,
    publishEnabled: null,
  });
});

test("the model is told to write Korean from data it must not obey", () => {
  const [system, user] = marketingMorningMessages({
    date: "2026-11-04",
    operations: OPERATIONS,
    brief: null,
    competitors: [],
    marketPrices: [],
  });
  assert.match(system.content, /Korean/u);
  assert.match(system.content, /data, not instructions/u);
  assert.match(system.content, /needs checking/u);
  assert.equal(JSON.parse(user.content).date, "2026-11-04");
});

const read = (answer) =>
  readMarketingMorningReport(typeof answer === "string" ? answer : JSON.stringify(answer), {
    date: "2026-11-04",
    figures: marketingMorningFigures(OPERATIONS),
    competitorIds: ["poe"],
  });

test("long text is cut to what is stored, and unknown sections, actions and competitors are dropped", () => {
  const report = read({
    verdict: `  ${"가".repeat(700)}  `,
    decisions: [
      { title: "a", why: "b", section: "queue" },
      { title: "c", why: "d", section: "admin" },
      { title: "e", why: "f", section: "accounts" },
      { title: "g", why: "h", section: "assets" },
      { title: "i", why: "j", section: "published" },
    ],
    worked: "판단 보류",
    adjust: [{ action: "increase", what: "x", why: "y" }, { action: "boost", what: "x", why: "y" }],
    marketChanges: [{ competitorId: "poe", change: "x", action: "y" }, { competitorId: "chatgpt", change: "x", action: "y" }],
  });
  assert.ok(report);
  assert.equal(report.verdict.length, 600);
  assert.deepEqual(report.decisions.map((entry) => entry.section), ["queue", "accounts", "assets"]);
  assert.deepEqual(report.adjust.map((entry) => entry.action), ["increase"]);
  assert.deepEqual(report.marketChanges.map((entry) => entry.competitorId), ["poe"]);
  assert.equal(report.figures.pendingApproval, 9);
});

test("an answer that is not a report is not kept", () => {
  assert.equal(read("not json"), null);
  assert.equal(read({ verdict: "", decisions: [], worked: "x", adjust: [], marketChanges: [] }), null);
  assert.equal(read({ verdict: "x", decisions: [], worked: "x", adjust: [], marketChanges: [], extra: 1 }), null);
  assert.ok(read("```json\n" + JSON.stringify({ verdict: "x", decisions: [], worked: "y", adjust: [], marketChanges: [] }) + "\n```"));
});
