import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OpenRecommendationsInbox, RecommendationControls } from "@/components/admin/AdminAutoRouterRecommendations";
import { adminAutoRouterOptimizerMessages } from "@/lib/adminMessages/autoRouterOptimizer";
import { actionableRecommendations } from "@/lib/autoRouterRecommendationsCore";

// Admin › Routing › the optimizer's open recommendations, rendered. The inbox
// names how many cycles it read (docs/ui-contracts/admin-console-ia.md rule 6),
// lists only what is unhandled, and offers the copy button on each; a handled
// recommendation offers reopen instead of done and dismiss.

const m = adminAutoRouterOptimizerMessages.en;
const report = {
  findings: ["answer calls failed for two models"],
  recommendations: [
    { kind: "guidance", text: "GUIDANCE-REC" },
    { kind: "code", text: "CODE-REC-A" },
    { kind: "setting", text: "SETTING-REC-B" },
  ],
};
const cycles = [
  { id: "cyc_new", createdAt: "2026-10-20T00:00:00.000Z", summary: { report } },
  {
    id: "cyc_old",
    createdAt: "2026-10-18T00:00:00.000Z",
    summary: {
      report,
      recommendationStatus: { 1: { status: "done", at: "2026-10-19T00:00:00.000Z", by: "u1" } },
    },
  },
  { id: "cyc_none", createdAt: "2026-10-19T00:00:00.000Z", summary: null },
];
const noop = () => undefined;

const text = (markup: string) => {
  let out = "";
  let inTag = false;
  for (const ch of markup) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out.replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
};
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

test("the inbox states how many it shows from how many cycles, and lists only unhandled recommendations", () => {
  const html = renderToStaticMarkup(createElement(OpenRecommendationsInbox, { cycles, busy: false, onSetStatus: noop }));
  const body = text(html);
  assert.ok(body.includes(m.inboxShowing(3, 3)), body);
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-open"'), 3);
  // The guidance recommendation is never offered, and the handled one is gone.
  assert.ok(!body.includes("GUIDANCE-REC"));
  assert.equal(count(body, "CODE-REC-A"), 1, "the cycle that marked it done no longer lists it");
  assert.equal(count(body, "SETTING-REC-B"), 2);
  // Each open item can be marked, dismissed and copied, and links to its cycle.
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-copy"'), 3);
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-done"'), 3);
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-dismiss"'), 3);
  assert.ok(html.includes('href="#optimizer-cycle-cyc_new"'));
  // Newest cycle first.
  assert.ok(html.indexOf("cyc_new") < html.indexOf("cyc_old"));
});

test("an empty inbox says so and still states what it read", () => {
  const html = renderToStaticMarkup(
    createElement(OpenRecommendationsInbox, { cycles: [{ id: "c", createdAt: "2026-10-20T00:00:00.000Z", summary: null }], busy: false, onSetStatus: noop })
  );
  const body = text(html);
  assert.ok(body.includes(m.inboxEmpty));
  assert.ok(body.includes(m.inboxShowing(0, 1)));
});

test("a handled recommendation offers reopen, not done and dismiss; buttons are disabled while busy", () => {
  const handled = actionableRecommendations(cycles[1].summary).find((item) => item.index === 1)!;
  assert.equal(handled.status, "done");
  const html = renderToStaticMarkup(
    createElement(RecommendationControls, { cycle: cycles[1], item: handled, busy: true, onSetStatus: noop })
  );
  assert.ok(html.includes('data-testid="admin-auto-router-recommendation-reopen"'));
  assert.ok(!html.includes('data-testid="admin-auto-router-recommendation-done"'));
  assert.ok(!html.includes('data-testid="admin-auto-router-recommendation-dismiss"'));
  assert.ok(html.includes('data-status="done"'));
  assert.ok(text(html).includes(m.recommendationStatuses.done));
  // Copying never writes, so it stays available while a write is in flight.
  const openingTag = (testId: string) => html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
  assert.ok(openingTag("admin-auto-router-recommendation-copy"));
  assert.ok(!openingTag("admin-auto-router-recommendation-copy").includes('disabled=""'));
  assert.ok(openingTag("admin-auto-router-recommendation-reopen").includes('disabled=""'));
});

test("an item the coding agent opened a PR for can be marked done directly, with its PR linked", () => {
  const summary = {
    report,
    recommendationStatus: {
      1: {
        status: "pr_opened",
        at: "2026-10-20T01:00:00.000Z",
        by: "auto-router-rec-agent",
        prUrl: "https://github.com/mposition/Tomverse/pull/4242",
        claimId: "11111111-1111-4111-8111-111111111111",
      },
    },
  };
  const item = actionableRecommendations(summary).find((entry) => entry.index === 1)!;
  const html = renderToStaticMarkup(
    createElement(RecommendationControls, {
      cycle: { id: "cyc_pr", createdAt: "2026-10-20T00:00:00.000Z", summary },
      item,
      busy: false,
      onSetStatus: noop,
    })
  );
  // Done and dismiss without reopening first, so the agent never takes it again in between.
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-done"'), 1);
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-dismiss"'), 1);
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-reopen"'), 0);
  assert.ok(html.includes('href="https://github.com/mposition/Tomverse/pull/4242"'));
  assert.ok(text(html).includes(m.recommendationStatuses.pr_opened));
});
