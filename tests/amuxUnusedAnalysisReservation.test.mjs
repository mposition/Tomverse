import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("one-click release lives on the idea detail and keeps an unknown write read-back only", () => {
  const panel = read("components/admin/AmuxIdeaReservationReleasePanel.tsx");
  const detail = read("components/admin/AmuxIdeaDetailSummary.tsx");
  const page = read("app/(site)/(application)/admin/amux-backlog/page.tsx");
  assert.match(detail, /notice === "analysis_waiting" \? <AmuxIdeaReservationReleasePanel/);
  assert.doesNotMatch(page, /AmuxUnusedAnalysisReservationPanel|tab\.id === "recovery"/);
  assert.match(page, /requestedTab === "intake" \|\| requestedTab === "recovery"/);
  assert.match(panel, /method: "DELETE"/);
  assert.match(panel, /JSON\.stringify\(\{ ideaId, confirmedUnused: true \}\)/);
  // The pending marker is written before the write and only a read-back clears it.
  assert.ok(panel.indexOf("sessionStorage.setItem(storageKey, ideaId)") < panel.indexOf('method: "DELETE"'));
  assert.match(panel, /if \(pending && !resolvePending\) \{ setPhase\("unknown"\); return; \}/);
  assert.match(panel, /row\.modelCallStarted === false/);
  assert.doesNotMatch(panel, /holdId|setInterval|setTimeout|analysis-claim-resolution|\.start\(/);
});

test("the idea route picks only the owner's holds and releases each through the canonical writer", () => {
  const route = read("app/api/admin/amux/ideas/analysis-reservations/route.ts");
  assert.match(route, /const cancelSchema = z\.object\(\{ ideaId: id, confirmedUnused: z\.literal\(true\) \}\)\.strict\(\);/);
  assert.match(route, /const owned = \{ ideaId, confirmedByUserId: ownerId \};/);
  // Candidates are filtered in the query, so closed holds never fill the bound.
  assert.match(route, /cliUsageEvents: \{ none: \{\} \},\s*preview: \{ \.\.\.owned, consumedAt: null, outcomeUnknownAt: null,/);
  assert.match(route, /idea\.actorUserId !== ownerId/);
  assert.match(route, /take: IDEA_HOLD_LIMIT/);
  assert.match(route, /commitAmuxIdeaAnalysisUnusedReservationCancellation\(tx, \{\s*session, request, holdId: candidate\.id, expectedPreviewId: candidate\.previewId,/);
  // Each hold commits in its own transaction; a later failure is an unknown outcome, never a retry.
  assert.match(route, /if \(released\.length === 0\) throw error;/);
  assert.match(route, /error: "outcome_unknown"/);
  assert.doesNotMatch(route, /amuxIdeaAnalysisBudgetHold\.update|amuxIdeaAnalysisBudgetWindow\.update|writeAdminAuditLog/);
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
