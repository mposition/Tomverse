import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import { dmReportInstant } from "@/components/admin/AmuxDecisionMakerReportPanel";
import { dmAdminRequestDetailHref } from "@/components/admin/AmuxDecisionMakerRequestDetailPanel";
import { AmuxDecisionMakerRequestsView } from "@/components/admin/AmuxDecisionMakerRequestsPanel";
import { adminAmuxDecisionMakerRequestsMessages } from "@/lib/adminMessages/amuxDecisionMaker";
import {
  DM_ADMIN_REQUEST_LIST_LIMIT,
  dmAdminRequestRowFromRow,
  type DmAdminRequestList,
  type DmAdminRequestRow,
} from "@/lib/amux/decisionMakerAdminCore";

/**
 * AMUX › Operations settings › Decision Maker, the newest requests
 * (docs/policy/amux-decision-maker.md §2, §6, §12 S2), executed: the hook-free
 * view is called and the element tree it returns is walked, as the other
 * client render tests do. The questions: each request shows its route, its
 * status and its delivery in words; an irreversible proposal is marked before
 * its status; the panel states how many rows it shows and that they are not
 * totals; a failed read shows no request; and nothing on the panel acts.
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

const byTestId = (node: ReactNode, id: string) => propsOf(node).filter((props) => props["data-testid"] === id);

const one = (node: ReactNode, id: string) => {
  const found = byTestId(node, id);
  assert.equal(found.length, 1, id);
  return found[0]!;
};

const NOW = Date.UTC(2026, 9, 13, 6, 0, 0);
const ID_PROPOSAL = "00000000-0000-4000-8000-000000000001";
const ID_OPERATOR = "00000000-0000-4000-8000-000000000002";
const ID_CONFIRMED = "00000000-0000-4000-8000-000000000003";

const row = (overrides: Record<string, unknown>): DmAdminRequestRow => {
  const parsed = dmAdminRequestRowFromRow({
    id: ID_PROPOSAL,
    cardId: "card-41",
    questionRevision: 2,
    askingWorkerId: "worker.claude-1",
    askingProvider: "claude",
    route: "dm_proposal",
    instance: "decision-maker-openai",
    refusalCodes: [],
    createdAtEpochMs: NOW - 60_000,
    assignmentDeadlineAtEpochMs: NOW + 60_000,
    assigned: true,
    snapshotState: null,
    transmitOutcome: null,
    resultKind: null,
    resultUnknown: false,
    closingKind: null,
    outputKind: null,
    irreversible: null,
    declarationAccuracy: null,
    delivered: false,
    deliveryOutcomeKind: null,
    deliveryNotSentReason: null,
    deliveryResolution: null,
    cleanupUnknownAtEpochMs: null,
    ...overrides,
  });
  assert.ok(parsed);
  return parsed;
};

const ID_CLEANUP = "00000000-0000-4000-8000-000000000004";
const CLEANUP_AT = NOW - 30_000;

/** One request whose cleanup was not confirmed (a timed-out one, §5) beside one that has none. */
const cleanupList = (): DmAdminRequestList => ({
  dbNowMs: NOW,
  rows: [
    row({ id: ID_CLEANUP, cardId: "card-44", resultKind: "timeout", snapshotState: "none", cleanupUnknownAtEpochMs: CLEANUP_AT }),
    row({ resultKind: "timeout", snapshotState: "none" }),
  ],
});

const list = (): DmAdminRequestList => ({
  dbNowMs: NOW,
  rows: [
    row({
      snapshotState: "worker_head",
      transmitOutcome: "transmit_receipt",
      resultKind: "proposal",
      outputKind: "select",
      irreversible: true,
    }),
    row({
      id: ID_OPERATOR,
      cardId: "card-40",
      questionRevision: 1,
      route: "operator",
      instance: "decision-maker-anthropic",
      assigned: false,
      refusalCodes: ["ask_type_not_allowed"],
      askingProvider: "codex",
    }),
    row({
      id: ID_CONFIRMED,
      cardId: "card-39",
      snapshotState: "none",
      resultKind: "proposal",
      outputKind: "free_text",
      irreversible: false,
      closingKind: "edit_confirm",
      declarationAccuracy: "matched",
      delivered: true,
      deliveryOutcomeKind: "delivery_receipt",
    }),
  ],
});

for (const locale of ["en", "ko"] as const) {
  const m = adminAmuxDecisionMakerRequestsMessages[locale];

  test(`${locale}: each request shows its route, status and delivery in words`, () => {
    const tree = AmuxDecisionMakerRequestsView({ m, list: list() });
    const proposal = one(tree, `amux-dm-request-status-${ID_PROPOSAL}`);
    assert.equal(proposal["data-status"], "proposal");
    assert.ok(textOf(proposal.children as ReactNode).includes(m.statuses.proposal));
    assert.equal(one(tree, `amux-dm-request-delivery-${ID_PROPOSAL}`)["data-delivery"], "not_applicable");

    const operator = one(tree, `amux-dm-request-status-${ID_OPERATOR}`);
    assert.equal(operator["data-status"], "routed_to_operator");
    assert.ok(textOf(operator.children as ReactNode).includes(m.statuses.routed_to_operator));
    // The refusal codes say why §3 kept the question with the operator.
    assert.ok(textOf(operator.children as ReactNode).includes(m.keptBecause("ask_type_not_allowed")));
    assert.ok(textOf(one(tree, `amux-dm-request-${ID_OPERATOR}`).children as ReactNode).includes(m.operator));

    const confirmed = one(tree, `amux-dm-request-status-${ID_CONFIRMED}`);
    assert.equal(confirmed["data-status"], "edit_confirm");
    const delivered = one(tree, `amux-dm-request-delivery-${ID_CONFIRMED}`);
    assert.equal(delivered["data-delivery"], "delivered");
    assert.equal(textOf(delivered.children as ReactNode), m.deliveries.delivered);
  });

  test(`${locale}: an irreversible proposal is marked before its status, and only that one`, () => {
    const tree = AmuxDecisionMakerRequestsView({ m, list: list() });
    const status = one(tree, `amux-dm-request-status-${ID_PROPOSAL}`);
    const text = textOf(status.children as ReactNode);
    assert.ok(text.indexOf(m.irreversible) >= 0 && text.indexOf(m.irreversible) < text.indexOf(m.statuses.proposal));
    assert.equal(byTestId(tree, `amux-dm-request-irreversible-${ID_PROPOSAL}`).length, 1);
    assert.equal(byTestId(tree, `amux-dm-request-irreversible-${ID_CONFIRMED}`).length, 0);
    assert.equal(byTestId(tree, `amux-dm-request-irreversible-${ID_OPERATOR}`).length, 0);
  });

  test(`${locale}: a request whose cleanup was not confirmed says so beside its status, and the list says what it means once`, () => {
    const tree = AmuxDecisionMakerRequestsView({ m, list: cleanupList() });
    const flagged = one(tree, `amux-dm-request-status-${ID_CLEANUP}`);
    // The status stays what the ledger says; the flag is added, not substituted.
    assert.equal(flagged["data-status"], "timeout");
    const text = textOf(flagged.children as ReactNode);
    assert.ok(text.includes(m.statuses.timeout));
    assert.ok(text.indexOf(m.statuses.timeout) < text.indexOf(m.cleanupUnknown));
    assert.equal(textOf(one(tree, `amux-dm-request-cleanup-unknown-${ID_CLEANUP}`).children as ReactNode), m.cleanupUnknown);
    // The other request carries no flag, and the notice counts only the flagged one.
    assert.equal(byTestId(tree, `amux-dm-request-cleanup-unknown-${ID_PROPOSAL}`).length, 0);
    assert.equal(
      textOf(one(tree, "amux-dm-requests-cleanup-unknown-notice").children as ReactNode),
      m.cleanupUnknownNotice(1),
    );
    // Nothing else on the screen names a directory, a path or a command.
    const screen = textOf(tree as ReactNode);
    assert.doesNotMatch(screen, /\/var\/|\/home\/|rm -|requests\//);
  });

  test(`${locale}: with no flagged request there is no flag and no notice`, () => {
    const tree = AmuxDecisionMakerRequestsView({ m, list: list() });
    assert.equal(byTestId(tree, "amux-dm-requests-cleanup-unknown-notice").length, 0);
    assert.equal(
      propsOf(tree).filter((props) => String(props["data-testid"] ?? "").startsWith("amux-dm-request-cleanup-unknown-")).length,
      0,
    );
    const failed = AmuxDecisionMakerRequestsView({ m, list: null });
    assert.equal(byTestId(failed, "amux-dm-requests-cleanup-unknown-notice").length, 0);
  });

  test(`${locale}: the panel states how many rows it shows, and that they are not totals`, () => {
    const tree = AmuxDecisionMakerRequestsView({ m, list: list() });
    assert.equal(
      textOf(one(tree, "amux-dm-requests-shown").children as ReactNode),
      `${m.shown(3, DM_ADMIN_REQUEST_LIST_LIMIT)} ${m.computedAt(dmReportInstant(NOW))}`,
    );
  });

  test(`${locale}: an empty ledger says so, and a failed read shows no request`, () => {
    const empty = AmuxDecisionMakerRequestsView({ m, list: { dbNowMs: NOW, rows: [] } });
    assert.equal(textOf(one(empty, "amux-dm-requests-empty").children as ReactNode), m.empty);
    const failed = AmuxDecisionMakerRequestsView({ m, list: null });
    const alert = one(failed, "amux-dm-requests-unavailable");
    assert.equal(alert.role, "alert");
    assert.equal(textOf(alert.children as ReactNode), m.unavailable);
    assert.equal(byTestId(failed, "amux-dm-requests-shown").length, 0);
    assert.equal(
      propsOf(failed).filter((props) => String(props["data-testid"] ?? "").startsWith("amux-dm-request-")).length,
      0,
    );
  });

  test(`${locale}: nothing on the panel acts; its only links open one request on the same tab`, () => {
    const tree = AmuxDecisionMakerRequestsView({ m, list: list() });
    const hrefs: unknown[] = [];
    for (const props of propsOf(tree)) {
      assert.equal(props.onClick, undefined);
      assert.equal(props.type, undefined);
      assert.equal(props.action, undefined);
      if (props.href !== undefined) hrefs.push(props.href);
    }
    assert.deepEqual(hrefs.sort(), [ID_PROPOSAL, ID_OPERATOR, ID_CONFIRMED].map(dmAdminRequestDetailHref).sort());
    assert.equal(dmAdminRequestDetailHref(ID_PROPOSAL), `/admin/amux-settings?tab=decision-maker&request=${ID_PROPOSAL}`);
  });
}
