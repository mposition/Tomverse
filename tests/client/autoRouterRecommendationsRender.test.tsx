import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  OpenRecommendationsInbox,
  RecommendationControls,
  recommendationKey,
  type RecommendationSendState,
} from "@/components/admin/AdminAutoRouterRecommendations";
import { adminAutoRouterOptimizerMessages } from "@/lib/adminMessages/autoRouterOptimizer";
import { actionableRecommendations } from "@/lib/autoRouterRecommendationsCore";

// Admin › Routing › the optimizer's open recommendations, rendered. The inbox
// names how many cycles it read (docs/ui-contracts/admin-console-ia.md rule 6),
// lists only what is unhandled, and offers the AMUX button on each; a handled
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
  const html = renderToStaticMarkup(createElement(OpenRecommendationsInbox, { cycles, busy: false, canSend: true, onSetStatus: noop, onSend: noop }));
  const body = text(html);
  assert.ok(body.includes(m.inboxShowing(3, 3)), body);
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-open"'), 3);
  // The guidance recommendation is never offered, and the handled one is gone.
  assert.ok(!body.includes("GUIDANCE-REC"));
  assert.equal(count(body, "CODE-REC-A"), 1, "the cycle that marked it done no longer lists it");
  assert.equal(count(body, "SETTING-REC-B"), 2);
  // Each open item can be marked, dismissed and sent, and links to its cycle.
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-send"'), 3);
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-done"'), 3);
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-dismiss"'), 3);
  assert.ok(html.includes('href="#optimizer-cycle-cyc_new"'));
  // Newest cycle first.
  assert.ok(html.indexOf("cyc_new") < html.indexOf("cyc_old"));
});

test("an empty inbox says so and still states what it read", () => {
  const html = renderToStaticMarkup(
    createElement(OpenRecommendationsInbox, { cycles: [{ id: "c", createdAt: "2026-10-20T00:00:00.000Z", summary: null }], busy: false, canSend: true, onSetStatus: noop, onSend: noop })
  );
  const body = text(html);
  assert.ok(body.includes(m.inboxEmpty));
  assert.ok(body.includes(m.inboxShowing(0, 1)));
});

test("a handled recommendation offers reopen, not done and dismiss; buttons are disabled while busy", () => {
  const handled = actionableRecommendations(cycles[1].summary).find((item) => item.index === 1)!;
  assert.equal(handled.status, "done");
  const html = renderToStaticMarkup(
    createElement(RecommendationControls, { cycle: cycles[1], item: handled, busy: true, canSend: true, onSetStatus: noop, onSend: noop })
  );
  assert.ok(html.includes('data-testid="admin-auto-router-recommendation-reopen"'));
  assert.ok(!html.includes('data-testid="admin-auto-router-recommendation-done"'));
  assert.ok(!html.includes('data-testid="admin-auto-router-recommendation-dismiss"'));
  assert.ok(html.includes('data-status="done"'));
  assert.ok(text(html).includes(m.recommendationStatuses.done));
  // A handled recommendation is not sent.
  assert.ok(!html.includes('data-testid="admin-auto-router-recommendation-send"'));
  const openingTag = (testId: string) => html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
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
      canSend: true,
      onSetStatus: noop,
      onSend: noop,
    })
  );
  // A PR is open, so it is not sent to AMUX as well.
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-send"'), 0);
  // Done and dismiss without reopening first, so the agent never takes it again in between.
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-done"'), 1);
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-dismiss"'), 1);
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-reopen"'), 0);
  assert.ok(html.includes('href="https://github.com/mposition/Tomverse/pull/4242"'));
  assert.ok(text(html).includes(m.recommendationStatuses.pr_opened));
});

test("Send to AMUX replaces the copy button; only an owner can press it, and a sent one shows its idea", () => {
  const open = actionableRecommendations(cycles[0].summary).find((entry) => entry.index === 1)!;
  const render = (item: typeof open, canSend: boolean) =>
    renderToStaticMarkup(
      createElement(RecommendationControls, { cycle: cycles[0], item, busy: false, canSend, onSetStatus: noop, onSend: noop })
    );
  const sendButton = (html: string) => html.match(/<button[^>]*data-testid="admin-auto-router-recommendation-send"[^>]*>/)?.[0] ?? "";

  const owner = render(open, true);
  assert.ok(text(owner).includes(m.sendToAmux));
  assert.ok(!sendButton(owner).includes('disabled=""'));
  assert.ok(!owner.includes("admin-auto-router-recommendation-copy"));

  const ops = render(open, false);
  assert.ok(sendButton(ops).includes('disabled=""'));
  assert.ok(sendButton(ops).includes(`title="${m.sendNotAllowed}"`));

  const summary = {
    report,
    recommendationStatus: { 1: { status: "sent_to_amux", at: "2026-10-21T00:00:00.000Z", by: "u1", amuxIdeaId: "idea-77" } },
  };
  const sent = actionableRecommendations(summary).find((entry) => entry.index === 1)!;
  const html = render(sent, true);
  assert.equal(sendButton(html), "");
  assert.ok(text(html).includes(m.recommendationStatuses.sent_to_amux));
  assert.ok(text(html).includes("idea-77"));
  // AMUX has it: it can still be closed, and is not reopened into the agent's queue from here.
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-done"'), 1);
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-reopen"'), 0);
});

test("the inbox keeps a sent recommendation with its status and idea, and offers no send for it", () => {
  const sentCycle = {
    id: "cyc_sent",
    createdAt: "2026-10-21T00:00:00.000Z",
    summary: {
      report,
      recommendationStatus: { 1: { status: "sent_to_amux", at: "2026-10-21T00:00:00.000Z", by: "u1", amuxIdeaId: "idea-77" } },
    },
  };
  const html = renderToStaticMarkup(
    createElement(OpenRecommendationsInbox, { cycles: [sentCycle], busy: false, canSend: true, onSetStatus: noop, onSend: noop })
  );
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-open"'), 2);
  assert.equal(count(html, 'data-status="sent_to_amux"'), 1);
  assert.ok(text(html).includes("idea-77"));
  // Only the other recommendation can still be sent.
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-send"'), 1);
});

test("a send in progress shows on its own button, and a refusal shows beside the button that was pressed", () => {
  const items = actionableRecommendations(cycles[0].summary);
  const code = items.find((entry) => entry.index === 1)!;
  const setting = items.find((entry) => entry.index === 2)!;
  const render = (item: typeof code, sendState: RecommendationSendState) =>
    renderToStaticMarkup(
      createElement(RecommendationControls, { cycle: cycles[0], item, busy: true, canSend: true, sendState, onSetStatus: noop, onSend: noop })
    );
  const key = recommendationKey("cyc_new", 1);

  const sending = { sendingKey: key, failure: null };
  assert.ok(text(render(code, sending)).includes(m.sendingToAmux));
  assert.ok(!text(render(setting, sending)).includes(m.sendingToAmux));

  const refused = {
    sendingKey: null,
    failure: { key, failure: { message: m.reasons.content_refused, tone: "error" as const, requiresReauthentication: false, approvalId: null } },
  };
  const failureId = 'data-testid="admin-auto-router-recommendation-send-failure"';
  assert.equal(count(render(code, refused), failureId), 1);
  assert.ok(text(render(code, refused)).includes(m.reasons.content_refused));
  assert.equal(count(render(setting, refused), failureId), 0);
});

test("a send that did not finish can be sent again or reopened", () => {
  const summary = {
    report,
    recommendationStatus: { 1: { status: "sending_to_amux", at: "2026-10-21T00:00:00.000Z", by: "u1" } },
  };
  const item = actionableRecommendations(summary).find((entry) => entry.index === 1)!;
  const html = renderToStaticMarkup(
    createElement(RecommendationControls, { cycle: cycles[0], item, busy: false, canSend: true, onSetStatus: noop, onSend: noop })
  );
  assert.ok(text(html).includes(m.recommendationStatuses.sending_to_amux));
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-send"'), 1);
  assert.equal(count(html, 'data-testid="admin-auto-router-recommendation-reopen"'), 1);
});
