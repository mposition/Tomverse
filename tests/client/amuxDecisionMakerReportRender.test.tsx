import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AmuxDecisionMakerReportView,
  dmReportInstant,
  dmReportMetricText,
} from "@/components/admin/AmuxDecisionMakerReportPanel";
import { adminAmuxDecisionMakerReportMessages } from "@/lib/adminMessages/amuxDecisionMaker";
import {
  DM_REPORT_DAY_MS,
  dmDeclarationAccuracyReport,
  type DmDeclarationAccuracyReport,
} from "@/lib/amux/decisionMakerJudgmentCore";
import { DM_INSTANCE_SCOPES } from "@/lib/amux/decisionMakerSwitchCore";

/**
 * AMUX › Execution › Decision Maker, §4's declaration accuracy report
 * (docs/policy/amux-decision-maker.md §4), executed: the hook-free view is
 * called and the element tree it returns is walked, as the other client
 * render tests do. The questions are the policy's: each figure over its own
 * denominator, an empty denominator as insufficient evidence and never a
 * zero, a failed read as no figure at all, and nothing on the panel that
 * acts or that compares the figures with a graduation criterion.
 */

type Props = Record<string, unknown>;

const propsOf = (node: ReactNode, found: Props[] = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, found);
    return found;
  }
  const element = node as { props?: Props };
  if (element.props) {
    found.push(element.props);
    propsOf(element.props.children as ReactNode, found);
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

const byTestId = (node: ReactNode, id: string) =>
  propsOf(node).filter((props) => props["data-testid"] === id);

const cell = (node: ReactNode, row: string, instance: string) => {
  const found = byTestId(node, `amux-dm-report-${row}-${instance}`);
  assert.equal(found.length, 1, `${row} ${instance}`);
  return textOf(found[0]!.children as ReactNode);
};

const NOW = Date.UTC(2026, 9, 12, 7, 51, 30);

const tally = (instance: (typeof DM_INSTANCE_SCOPES)[number], counts: Partial<Record<string, number>>) => ({
  instance,
  confirm: 0,
  editConfirm: 0,
  reject: 0,
  matched: 0,
  mismatched: 0,
  notJudged: 0,
  ...counts,
});

const emptyReport = (): DmDeclarationAccuracyReport =>
  dmDeclarationAccuracyReport({ dbNowMs: NOW, tallies: [], timeline: [] });

const measuredReport = (): DmDeclarationAccuracyReport =>
  dmDeclarationAccuracyReport({
    dbNowMs: NOW,
    tallies: [tally("decision-maker-openai", { confirm: 3, editConfirm: 1, matched: 2, notJudged: 2 })],
    timeline: [
      { instance: "decision-maker-openai", proposals: 5, firstProposalAtMs: NOW - 3 * DM_REPORT_DAY_MS - 1 },
      { instance: "decision-maker-anthropic", proposals: 0, firstProposalAtMs: null },
    ],
  });

for (const locale of ["en", "ko"] as const) {
  const m = adminAmuxDecisionMakerReportMessages[locale];

  test(`${locale}: an empty ledger is insufficient evidence in every cell, never a zero`, () => {
    const tree = AmuxDecisionMakerReportView({ m, report: emptyReport() });
    for (const instance of DM_INSTANCE_SCOPES) {
      assert.equal(cell(tree, "decidedProposals", instance), m.insufficientEvidence);
      assert.equal(cell(tree, "daysSinceFirstProposal", instance), m.noProposal);
      assert.equal(cell(tree, "confirmedWithoutEdit", instance), m.insufficientEvidence);
      assert.equal(cell(tree, "matchedOverJudged", instance), m.insufficientEvidence);
      assert.equal(cell(tree, "notJudged", instance), m.insufficientEvidence);
    }
    assert.doesNotMatch(textOf(tree), /0\.0%|\b0 \/ 0\b/);
    assert.equal(byTestId(tree, "amux-dm-report-unavailable").length, 0);
  });

  test(`${locale}: each figure is its numerator over its own denominator`, () => {
    const tree = AmuxDecisionMakerReportView({ m, report: measuredReport() });
    const openai = "decision-maker-openai";
    assert.equal(cell(tree, "decidedProposals", openai), "4 / 5 (80.0%)");
    assert.equal(cell(tree, "confirmedWithoutEdit", openai), "3 / 4 (75.0%)");
    assert.equal(cell(tree, "matchedOverJudged", openai), "2 / 2 (100.0%)");
    assert.equal(cell(tree, "notJudged", openai), "2 / 4 (50.0%)");
    assert.equal(
      cell(tree, "daysSinceFirstProposal", openai),
      m.days(3, dmReportInstant(NOW - 3 * DM_REPORT_DAY_MS - 1)),
    );
    // The other instance has no proposal of its own: its cells do not borrow the first's.
    const anthropic = "decision-maker-anthropic";
    assert.equal(cell(tree, "decidedProposals", anthropic), m.insufficientEvidence);
    assert.equal(cell(tree, "daysSinceFirstProposal", anthropic), m.noProposal);
    // Both instances are listed, in the policy's order, by their stored ids.
    const headers = propsOf(tree)
      .filter((props) => props.scope === "col")
      .map((props) => textOf(props.children as ReactNode));
    assert.deepEqual(headers, [m.measure, ...DM_INSTANCE_SCOPES]);
    assert.equal(
      textOf(byTestId(tree, "amux-dm-report-computed-at")[0]!.children as ReactNode),
      m.computedAt("2026-10-12 07:51 UTC"),
    );
  });

  test(`${locale}: a failed read shows no figure, only that it could not be read`, () => {
    const tree = AmuxDecisionMakerReportView({ m, report: null });
    const alert = byTestId(tree, "amux-dm-report-unavailable");
    assert.equal(alert.length, 1);
    assert.equal(alert[0]!.role, "alert");
    assert.equal(textOf(alert[0]!.children as ReactNode), m.unavailable);
    assert.equal(propsOf(tree).filter((props) => typeof props["data-testid"] === "string" &&
      (props["data-testid"] as string).startsWith("amux-dm-report-decidedProposals")).length, 0);
    assert.equal(byTestId(tree, "amux-dm-report-computed-at").length, 0);
  });

  test(`${locale}: the report offers no control and names no graduation criterion`, () => {
    for (const report of [emptyReport(), measuredReport(), null]) {
      const tree = AmuxDecisionMakerReportView({ m, report });
      const controls = propsOf(tree).filter(
        (props) => typeof props.onClick === "function" || typeof props.onSubmit === "function" || props.type === "button",
      );
      assert.deepEqual(controls, []);
    }
    // §0-2's criteria (50 proposals, 30 days, 95%) are not in the copy: the
    // report is a value and nothing here measures it against them. The
    // figures themselves are the ledger's, so only the words are checked.
    const words = Object.values(m)
      .map((value) => (typeof value === "function" ? (value as (...args: unknown[]) => string)(1, "at") : value))
      .join("\n");
    assert.doesNotMatch(words, /\b50\b|\b30\b|\b95\b/);
    assert.doesNotMatch(textOf(AmuxDecisionMakerReportView({ m, report: emptyReport() })), /\b50\b|\b30\b|\b95\b/);
  });
}

test("a metric's words come only from its status", () => {
  const m = adminAmuxDecisionMakerReportMessages.en;
  assert.equal(
    dmReportMetricText(m, { status: "insufficient_evidence", numerator: 0, denominator: 0, value: null }),
    m.insufficientEvidence,
  );
  assert.equal(dmReportMetricText(m, { status: "measured", numerator: 0, denominator: 7, value: 0 }), "0 / 7 (0.0%)");
  assert.equal(dmReportMetricText(m, { status: "measured", numerator: 1, denominator: 3, value: 1 / 3 }), "1 / 3 (33.3%)");
});

test("the panel reads nothing and writes nothing of its own", () => {
  // The page reads the report inside the AMUX boundary and passes it in; the
  // panel issues no request, so it can neither change a switch nor be the
  // place a failed read turns into a figure.
  const source = readFileSync(join(process.cwd(), "components/admin/AmuxDecisionMakerReportPanel.tsx"), "utf8");
  assert.doesNotMatch(source, /adminFetch|fetch\(|useState|useEffect|\/api\//);
});
