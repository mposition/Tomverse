import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("standalone exact-ID cancellation survives preview expiry and keeps unknown writes read-only", () => {
  const panel = read("components/admin/AmuxUnusedAnalysisReservationPanel.tsx");
  const page = read("app/(site)/(application)/admin/amux-backlog/page.tsx");
  assert.match(page, /<AmuxUnusedAnalysisReservationPanel operatorId=\{session.user.id\}/);
  assert.match(panel, /method: "DELETE"/);
  assert.match(panel, /sessionStorage.setItem\(key, hold.id\)/);
  assert.ok(panel.indexOf("sessionStorage.setItem(key, hold.id)") < panel.indexOf('method: "DELETE"'));
  assert.match(panel, /row\.status === "released" && row\.cancellationAuditId/);
  assert.match(panel, /confirmed \|\| unknown \|\| inFlight.current/);
  assert.match(panel, /onRetry=\{busy \? undefined : onRead\}/);
  assert.match(panel, /isAmuxClaimResolutionWriteOutcomeUnknown\(response.status, body\)/);
  assert.match(panel, /AdminApiFailureNotice/);
  assert.doesNotMatch(panel, /setInterval|setTimeout|fetch\(|analysis-claim-resolution|\.start\(/);
});

test("cancellation writer locks and audits before releasing; no model, key, user-credit or halt writes", () => {
  const service = read("lib/amux/ideaAnalysisBudgetCancellationService.ts");
  assert.match(service, /expectedPreviewId !== identity.previewId/);
  assert.match(service, /hold\._count.cliUsageEvents !== 0/);
  assert.match(service, /hold\.status !== "reserved"/);
  assert.match(service, /hold\.dispatchedAt !== null/);
  assert.match(service, /preview\.consumedAt !== null \|\| preview\.outcomeUnknownAt !== null/);
  assert.ok(service.indexOf("writeAdminAuditLog({") < service.indexOf("amuxIdeaAnalysisBudgetWindow.updateMany"));
  assert.doesNotMatch(service, /CreditAccount|CreditLot|providerCall|loadAmuxContent|clearHalt/);
});
