import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShadowReport } from "@/components/admin/AdminRoutingShadowPanel";
import {
  AutoRouterOverviewView,
  autoRouterKindShares,
  autoRouterShadowSplit,
} from "@/components/admin/routing/AutoRouterOverview";
import { optimizerCycleTone } from "@/components/admin/routing/optimizerTone";
import { adminRoutingScreensMessages } from "@/lib/adminMessages/routingScreens";

const report = (overrides: Partial<ShadowReport> = {}): ShadowReport => ({
  windowDays: 7,
  since: "2026-11-01T00:00:00.000Z",
  truncated: false,
  rows: 120,
  decided: 100,
  undecided: 20,
  agreed: 64,
  agreementRate: 0.64,
  versions: {
    taskProfileVersions: [],
    candidateFilterVersions: [],
    selectionVersions: [],
    selectionPolicyVersions: [],
    mixed: false,
  },
  switches: [],
  byTaskKind: [
    { key: "coding", decided: 40, agreed: 30, agreementRate: 0.75 },
    { key: "writing", decided: 30, agreed: 20, agreementRate: 0.6667 },
    { key: "general", decided: 30, agreed: 14, agreementRate: 0.4667 },
    { key: "research", decided: 0, agreed: 0, agreementRate: null },
  ],
  byPlan: [],
  selectionReasons: {},
  rejectionReasons: {},
  decisionMicrosP50: 200_000,
  decisionMicrosP95: 310_000,
  ...overrides,
});

const view = (props: Partial<Parameters<typeof AutoRouterOverviewView>[0]> = {}) =>
  renderToStaticMarkup(
    <AutoRouterOverviewView
      router="off"
      report={report()}
      failed={false}
      loading={false}
      onRetry={() => {}}
      {...props}
    />
  );

test("kind shares are portions of what was decided, largest first, without empty kinds", () => {
  const shares = autoRouterKindShares(report());
  assert.deepEqual(shares.map((row) => row.key), ["coding", "writing", "general"]);
  assert.equal(shares[0].share, 0.4);
  assert.ok(Math.abs(shares.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
  assert.deepEqual(autoRouterKindShares(report({ byTaskKind: [] })), []);
});

test("the shadow split is agreed, moved and no-candidate, and is null when nothing was recorded", () => {
  const split = autoRouterShadowSplit(report());
  assert.ok(split);
  assert.deepEqual(split.parts.map((part) => [part.key, part.count]), [
    ["agreed", 64],
    ["switched", 36],
    ["noCandidate", 20],
  ]);
  assert.equal(split.total, 120);
  assert.equal(autoRouterShadowSplit(report({ decided: 0, undecided: 0, agreed: 0 })), null);
});

test("the overview draws the flow, four numbers and the split from the shadow report", () => {
  const html = view();
  assert.match(html, /data-testid="admin-auto-router-flow-question"/);
  assert.match(html, /data-testid="admin-auto-router-flow-router"/);
  assert.match(html, /Coding/);
  assert.match(html, /40\.0%/);
  assert.equal(html.match(/<p class="text-sm font-medium text-zinc-400">/g)?.length, 4);
  assert.match(html, /310\.0ms/);
  assert.match(html, /data-testid="admin-auto-router-shadow-summary"/);
  assert.match(html, /role="img" aria-label="Auto would have chosen the same model 53\.3%/);
  // The router is off: the flow says so rather than naming a model.
  assert.match(html, /data-tone="idle"[^>]*>Off</);
});

test("a chosen router model is named in the flow", () => {
  const html = view({ router: { id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai" } });
  assert.match(html, />GPT 6 Luna</);
  assert.match(html, /data-tone="ok"[^>]*>On</);
});

test("an unread router setting is unknown, never off", () => {
  const html = view({ router: "unknown" });
  assert.match(html, /data-tone="unknown"/);
  assert.doesNotMatch(html, /data-tone="idle"/);
});

test("a failed shadow read is an alert with a retry and every number is unavailable, not zero", () => {
  const html = view({ report: null, failed: true });
  assert.match(html, /role="alert"/);
  assert.match(html, /Try again/);
  assert.equal(html.match(/data-unread="true"/g)?.length, 4);
  assert.doesNotMatch(html, />0</);
});

test("an empty window says so instead of drawing an empty bar", () => {
  const html = view({ report: report({ rows: 0, decided: 0, undecided: 0, agreed: 0, byTaskKind: [] }) });
  assert.match(html, /No decisions were recorded in this window/);
  assert.doesNotMatch(html, /role="img"/);
});

test("optimizer cycle statuses map to tones and an unknown status is idle", () => {
  assert.equal(optimizerCycleTone("running"), "info");
  assert.equal(optimizerCycleTone("passed"), "ok");
  assert.equal(optimizerCycleTone("failed"), "warn");
  assert.equal(optimizerCycleTone("error"), "bad");
  assert.equal(optimizerCycleTone("something-new"), "idle");
});

test("the routing screen copy has the same keys in English and Korean and no Korean in English", () => {
  const keys = (value: unknown, prefix = ""): string[] =>
    value && typeof value === "object"
      ? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`))
      : [prefix];
  assert.deepEqual(keys(adminRoutingScreensMessages.ko), keys(adminRoutingScreensMessages.en));
  assert.doesNotMatch(JSON.stringify(adminRoutingScreensMessages.en), /[^\x00-\x7F]/);
});
