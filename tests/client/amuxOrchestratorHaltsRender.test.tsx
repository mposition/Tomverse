import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";
import { AmuxOrchestratorHaltsView, amuxHaltAttention, amuxHaltClearReady, amuxHaltHasAutomaticEvidence } from "@/components/admin/AmuxOrchestratorHaltsPanel";
import { adminAmuxOrchestratorHaltsMessages } from "@/lib/adminMessages/amuxOrchestratorHalts";
import type { AmuxOrchestratorAdminHalt, AmuxOrchestratorAdminView } from "@/lib/amux/orchestratorHaltStore";

const halt = (overrides: Partial<AmuxOrchestratorAdminHalt> = {}): AmuxOrchestratorAdminHalt => ({
  haltId: "00000000-0000-4000-8000-000000000001", haltKey: "00000000-0000-4000-8000-000000000002",
  requestId: "00000000-0000-4000-8000-000000000002", reasonCode: "recovery_outcome_unknown",
  openedAt: "2026-10-12T00:00:00Z", clearedAt: null, clearKind: null, clearedByUserId: null,
  clearAuditLogId: null, clearEvidenceAuditLogId: null, write: null, ...overrides,
});
const write = { requestId: "00000000-0000-4000-8000-000000000002", callKind: "recover" as const,
  admittedAt: "2026-10-12T00:00:00Z", deadlineAt: "2026-10-12T00:00:12Z", ackedAt: null,
  resolvedAt: null, resolution: null, receiptCount: 0, receipts: [] };
const empty: AmuxOrchestratorAdminView = { openCount: 0, clearedCount: 0, humanRequiredCount: 0, open: [], cleared: [], humanRequired: [] };
type Props = Record<string, unknown>;
function propsOf(node: ReactNode, all: Props[] = []): Props[] {
  if (Array.isArray(node)) { node.forEach(child => propsOf(child, all)); return all; }
  if (node && typeof node === "object" && "props" in node) {
    const props = node.props as Props; all.push(props); propsOf(props.children as ReactNode, all);
  }
  return all;
}
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  return node && typeof node === "object" && "props" in node ? textOf((node.props as Props).children as ReactNode) : "";
}
const render = (view: AmuxOrchestratorAdminView | null, canClear = true) => AmuxOrchestratorHaltsView({ view, canClear,
  m: adminAmuxOrchestratorHaltsMessages.en, locale: "en", limits: { open: 50, cleared: 20, human: 50 }, onRefresh: () => {} });

test("failed evidence reads are unknown alerts, never a zero-halt success", () => {
  const tree = render(null);
  assert.match(textOf(tree), /Recovery evidence could not be read/);
  assert.doesNotMatch(textOf(tree), /No halt needs attention|Open halts: 0/);
  assert.equal(propsOf(tree).find(p => p["data-testid"] === "amux-halt-status")?.role, "alert");
  assert.match(textOf(render(empty)), /Execution switches and other admission conditions/);
});
test("missing admissions and committed changes remain human decisions", () => {
  assert.equal(amuxHaltAttention(halt()), "operator_required");
  assert.equal(amuxHaltAttention(halt({ write: { ...write, receiptCount: 1 } })), "operator_required");
  const tree = render({ ...empty, openCount: 1, open: [halt()] });
  assert.match(textOf(tree), /not confirmation of no change/);
  assert.equal(propsOf(tree).filter(p => p.haltId === halt().haltId).length, 1);
  assert.equal(propsOf(render({ ...empty, openCount: 1, open: [halt()] }, false)).filter(p => p.haltId === halt().haltId).length, 0);
});
test("pending zero-receipt decisions offer no manual clear while the server verifies them", () => {
  const item = halt({ write });
  assert.equal(amuxHaltAttention(item), "automatic_pending");
  const tree = render({ ...empty, openCount: 1, open: [item] });
  assert.equal(propsOf(tree).find(p => p["data-testid"] === "amux-halt-row")?.["data-attention"], "automatic_pending");
  assert.equal(propsOf(tree).filter(p => p.haltId === item.haltId).length, 0);
});
test("automatic history needs the matching request, outcome and both audit references", () => {
  const item = halt({ clearedAt: "2026-10-12T00:01:00Z", clearKind: "system_no_commit",
    clearAuditLogId: "audit-clear", clearEvidenceAuditLogId: "audit-evidence",
    write: { ...write, resolution: "no_commit", resolvedAt: "2026-10-12T00:00:18Z" } });
  assert.equal(amuxHaltHasAutomaticEvidence(item), true);
  for (const invalid of [halt({ ...item, clearEvidenceAuditLogId: null }), halt({ ...item, write: { ...item.write!, receiptCount: 1 } }), halt({ ...item, requestId: "other-request" })]) {
    assert.equal(amuxHaltHasAutomaticEvidence(invalid), false);
    const tree = render({ ...empty, clearedCount: 1, cleared: [invalid] });
    const row = propsOf(tree).find(p => p["data-testid"] === "amux-halt-row");
    assert.match(textOf(row?.children as ReactNode), /Clear evidence unavailable/);
  }
});
test("contract and prolonged read failures explicitly require fixing the cause", () => {
  for (const reasonCode of ["contract_violation", "selection_read_failures"] as const)
    assert.equal(amuxHaltAttention(halt({ reasonCode, requestId: null })), "cause_required");
});
test("an eight-character key alone does not satisfy the operator confirmation controls", () => {
  assert.equal(amuxHaltClearReady("00000000", [false, false, false]), false);
  assert.equal(amuxHaltClearReady("00000000", [true, false, true]), false);
  assert.equal(amuxHaltClearReady("0000000", [true, true, true]), false);
  assert.equal(amuxHaltClearReady("00000000", [true, true, true]), true);
});
