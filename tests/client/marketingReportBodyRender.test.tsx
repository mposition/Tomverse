import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import { MarketingReportBody } from "@/components/admin/AdminMarketingPanel";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";

/**
 * The Reports tab's opened row, executed: the component is called and the
 * returned element tree walked, like the other client render tests.
 */

const m = adminMarketingMessages.en as unknown as Record<string, string>;

type El = { type?: unknown; props?: Record<string, unknown> };

const elements = (node: ReactNode, found: El[] = []): El[] => {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found);
    return found;
  }
  const element = node as El;
  if (element.props) {
    found.push(element);
    elements(element.props.children as ReactNode, found);
  }
  return found;
};

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
};

const byTestId = (tree: ReactNode, id: string) =>
  elements(tree).filter((el) => el.props?.["data-testid"] === id);

const marketIntel = (unrepresentableFactCount: number, sourceUrl = "https://acme.example/pricing") => ({
  id: "rep1",
  kind: "market_intel",
  competitorNames: { acme: "Acme AI" },
  payload: {
    facts: [
      {
        competitorId: "acme",
        factType: "plan_price",
        value: { kind: "money", amountMinor: 2000, currency: "USD" },
        sourceUrl,
        checkedAt: "2026-11-01T00:30:00Z",
      },
      {
        competitorId: "acme",
        factType: "plan_tier",
        value: { kind: "token", value: "pro" },
        sourceUrl: "https://acme.example/plans",
        checkedAt: "2026-11-01T00:31:00Z",
      },
    ],
    unrepresentableFactCount,
  },
});

test("market facts are grouped under the competitor's name with the left-out count on top", () => {
  const tree = MarketingReportBody({ report: marketIntel(3), m });
  const text = textOf(tree);
  assert.match(text, /2 facts/);
  assert.match(text, /3 facts left out because they did not fit the storage format/);
  assert.equal(byTestId(tree, "marketing-report-competitor").length, 1);
  assert.match(textOf(byTestId(tree, "marketing-report-competitor")[0] as ReactNode), /Acme AI/);
  const facts = byTestId(tree, "marketing-report-fact").map((el) => textOf(el as ReactNode));
  assert.match(facts[0], /plan_price\s+USD 20\.00/);
  assert.match(facts[1], /plan_tier\s+pro/);
});

test("the left-out count is not shown when nothing was left out", () => {
  const tree = MarketingReportBody({ report: marketIntel(0), m });
  assert.equal(byTestId(tree, "marketing-report-unrepresentable").length, 0);
});

test("a source link opens a new tab without a referrer or opener", () => {
  const links = byTestId(MarketingReportBody({ report: marketIntel(0), m }), "marketing-report-source-link");
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.equal(link.props?.target, "_blank");
    assert.equal(link.props?.rel, "noopener noreferrer");
  }
  assert.equal(links[0].props?.href, "https://acme.example/pricing");
});

test("a non-https source is text, never a link", () => {
  const tree = MarketingReportBody({ report: marketIntel(0, "http://acme.example/x"), m });
  assert.equal(byTestId(tree, "marketing-report-source-link").length, 1);
  assert.match(textOf(tree), /http:\/\/acme\.example\/x/);
});

test("a report with no facts says so", () => {
  const tree = MarketingReportBody({
    report: { id: "r", kind: "market_intel", competitorNames: {}, payload: { facts: [], unrepresentableFactCount: 0 } },
    m,
  });
  assert.match(textOf(tree), /No facts in this report/);
});

test("weekly_kpi shows the counts, guard codes and per-account totals", () => {
  const tree = MarketingReportBody({
    report: {
      id: "r",
      kind: "weekly_kpi",
      competitorNames: {},
      payload: {
        postsPublished: 4,
        postsRejected: 1,
        guardRejectionsByCode: [{ code: "claim_unbacked", count: 2 }],
        channelTotals: [{ accountSlug: "linkedin-1", published: 4, failed: 0 }],
      },
    },
    m,
  });
  assert.equal(byTestId(tree, "marketing-report-weekly-kpi").length, 1);
  const text = textOf(tree);
  // Field is a component, so its label and value are read from its props.
  const fields = elements(tree)
    .filter((el) => typeof el.props?.label === "string")
    .map((el) => [el.props?.label, el.props?.value]);
  assert.deepEqual(fields, [
    ["Posts published", "4"],
    ["Posts rejected", "1"],
  ]);
  assert.match(text, /claim_unbacked\s+2/);
  assert.match(text, /linkedin-1\s+4\s+0/);
});

test("any other kind is indented JSON", () => {
  const tree = MarketingReportBody({
    report: { id: "r", kind: "experiment_result", competitorNames: {}, payload: { experimentId: "e1", variantId: "v1", exposures: 10, conversions: 2 } },
    m,
  });
  const pre = byTestId(tree, "marketing-report-json");
  assert.equal(pre.length, 1);
  assert.equal(textOf(pre[0] as ReactNode), JSON.stringify({ experimentId: "e1", variantId: "v1", exposures: 10, conversions: 2 }, null, 2));
});
