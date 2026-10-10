import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AmuxUnusedAnalysisReservationView } from "@/components/admin/AmuxUnusedAnalysisReservationPanel";
import { adminAmuxAnalysisBudgetMessages } from "@/lib/adminMessages/amuxAnalysisBudget";
import { isAmuxClaimResolutionWriteOutcomeUnknown } from "@/lib/amux/ideaAnalysisClaimResolutionUiCore";

const hold = { id: "synthetic-hold", previewId: "synthetic-preview", status: "reserved",
  reservedMicroUsd: "10560000", expiresAt: "2026-10-01T00:00:00.000Z",
  canCancel: true, cancellationAuditId: null as string | null };
const render = (changes: Partial<Parameters<typeof AmuxUnusedAnalysisReservationView>[0]> = {}) =>
  renderToStaticMarkup(<AmuxUnusedAnalysisReservationView
    m={adminAmuxAnalysisBudgetMessages.en.cancellation} holdId={hold.id} hold={hold}
    available={true} confirmed={true} busy={false} unknown={false} failure={null}
    onRead={() => {}} onCancel={() => {}} onConfirmedChange={() => {}} onHoldIdChange={() => {}}
    {...changes} />);

test("an expired unused preview offers cancellation only with the budget gates enabled", () => {
  assert.match(render(), /amux-unused-reservation-cancel/);
  assert.match(render({ available: false }), /data-testid="amux-unused-reservation-cancel" disabled/);
  assert.match(render({ confirmed: false }), /data-testid="amux-unused-reservation-cancel" disabled/);
});

test("unknown writes remain read-only even when a reread is reserved or not visible", () => {
  for (const current of [hold, null]) {
    const html = render({ hold: current, unknown: true });
    assert.match(html, /cancellation outcome is unknown/);
    assert.match(html, /data-testid="amux-unused-reservation-id"[^>]*disabled/);
    assert.match(html, /amux-unused-reservation-read/);
    assert.doesNotMatch(html, /amux-unused-reservation-cancel/);
  }
  // A current reserved row is not proof that an earlier COMMIT cannot still
  // arrive. Only an exact cancellation audit receipt resolves a lost reply.
  assert.equal(isAmuxClaimResolutionWriteOutcomeUnknown(503, null), true);
  assert.equal(isAmuxClaimResolutionWriteOutcomeUnknown(503, { error: "outcome_unknown" }), true);
  assert.equal(isAmuxClaimResolutionWriteOutcomeUnknown(503, { error: "integrity_unavailable" }), false);
});

test("released readback requires a canonical owner cancellation audit before showing success", () => {
  const released = { ...hold, status: "released", canCancel: false };
  assert.doesNotMatch(render({ hold: released }), /This unused reservation was released/);
  const html = render({ hold: { ...released, cancellationAuditId: "synthetic-audit" } });
  assert.match(html, /This unused reservation was released/);
  assert.match(html, /synthetic-audit/);
  assert.doesNotMatch(html, /amux-unused-reservation-cancel/);
});
