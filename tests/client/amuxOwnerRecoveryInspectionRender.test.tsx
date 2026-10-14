import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React, { type ReactNode } from "react";
import { AmuxRecoveryInspectionView, fetchAmuxRecoveryInspection,
  AMUX_RECOVERY_INSPECTION_TIMEOUT_MS, AmuxHostRecoveryView, fetchAmuxHostRecovery,
  AmuxOwnerRecoveryInspectionPanel, bindAmuxHostRecovery,
  AMUX_HOST_EVIDENCE_AUTO_READ_MS, AMUX_HOST_EVIDENCE_AUTO_READS } from
  "@/components/admin/AmuxOwnerRecoveryInspectionPanel";
import type { AmuxHostRecoveryRead } from "@/components/admin/AmuxOwnerRecoveryInspectionPanel";
import type { AmuxV22RecoveryRead } from "@/lib/amux/v22TaskRecoveryCore";
import { adminAmuxRecoveryInspectionMessages } from "@/lib/adminMessages/amuxRecoveryInspection";
import { summarizeAmuxRecoveryUsage, type AmuxOwnerRecoveryInspection } from
  "@/lib/amux/ownerRecoveryInspectionCore";
import { bindAmuxPendingRecovery, readAmuxPendingRecovery, saveAmuxPendingRecovery,
  clearAmuxPendingRecovery, type AmuxPendingRecovery } from "@/lib/amux/ownerRecoveryPending";

const identity = { taskId: "task-1", taskRevision: 4, attemptId: "attempt-1" };
const fixture = (): AmuxOwnerRecoveryInspection => ({ schemaVersion: 1,
  checkedAt: "2026-10-13T01:00:00.000Z", task: { id: "task-1", revision: 4, status: "blocked" },
  attempt: { id: "attempt-1", taskRevision: 3, worker: "claude-chore", outcome: "expired",
    endedAt: "2026-10-13T00:00:00.000Z", heartbeatAt: "2026-10-12T23:55:00.000Z", leaseExpiresAt: null },
  result: { state: "not_recorded", sha256: null, bodyVerified: false }, usage: summarizeAmuxRecoveryUsage([]),
  cost: { reservedMaximumMicrousd: "3400000", confirmed: false, settledMicrousd: null },
  deliveryStatus: "acknowledged", runtime: { state: "same_instance", status: "idle",
    heartbeatAt: "2026-10-13T01:00:00.000Z", leaseExpiresAt: "2026-10-13T01:02:00.000Z" },
  ubuntuProcessVerified: false, recoveryAuthorized: false });
const propsOf = (node: ReactNode, found: Record<string, unknown>[] = []) => {
  if (node == null || typeof node !== "object") return found;
  if (Array.isArray(node)) { node.forEach((child) => propsOf(child, found)); return found; }
  const element = node as { props?: Record<string, unknown> };
  if (element.props) { found.push(element.props); propsOf(element.props.children as ReactNode, found); }
  return found;
};
const textOf = (node: ReactNode): string => node == null || typeof node === "boolean" ? ""
  : typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(textOf).join(" ")
      : textOf((node as { props?: { children?: ReactNode } }).props?.children);

test("Korean inspection shows reservation and unknown cost plainly, never offers an unsafe retry", () => {
  const tree = AmuxRecoveryInspectionView({ m: adminAmuxRecoveryInspectionMessages.ko,
    state: { state: "ready", inspection: fixture() }, onInspect: () => {}, onReloadReview: () => {}, date: (value) => value });
  const text = textOf(tree);
  assert.match(text, /US\$3\.4/); assert.match(text, /0이 아니라 미확인/);
  assert.match(text, /Ubuntu 프로그램 종료는 아직 미확인/);
  assert.match(text, /정지를 해제하거나 비용을 정산하지 않았습니다/);
  assert.equal(propsOf(tree).filter((props) => props["data-testid"] === "admin-amux-inspect-records").length, 1);
  assert.equal(propsOf(tree).some((props) => props["data-testid"] === "admin-amux-review-outcome-retry"), false);
});
test("a refused step-up returns to the review the caller names, else the Assignment section", () => {
  const failure = { message: "sign in again", tone: "error" as const, requiresReauthentication: true, approvalId: null };
  const notice = (returnTo?: string) => propsOf(AmuxRecoveryInspectionView({ m: adminAmuxRecoveryInspectionMessages.en,
    state: { state: "unavailable", failure }, onInspect: () => {}, onReloadReview: () => {},
    date: (value) => value, ...(returnTo ? { returnTo } : {}) })).find((props) => props.failure === failure);
  assert.equal(notice()?.returnTo, "/admin/amux-execution?tab=assignment");
  assert.equal(notice("/admin/amux-execution?tab=cards&taskId=task-1")?.returnTo,
    "/admin/amux-execution?tab=cards&taskId=task-1");
  const host = propsOf(AmuxHostRecoveryView({ m: adminAmuxRecoveryInspectionMessages.en,
    state: { state: "unavailable", failure, requestId: "11111111-1111-4111-8111-111111111111", unknownWrite: false }, confirmed: false,
    onConfirm: () => {}, onRequest: () => {}, onRefresh: () => {}, onApprove: () => {},
    onReloadReview: () => {}, canRequest: true, returnTo: "/admin/amux-execution?tab=cards&taskId=task-1" }))
    .find((props) => props.failure === failure);
  assert.equal(host?.returnTo, "/admin/amux-execution?tab=cards&taskId=task-1");
});
test("changed records require review reload and do not retain a misleading prior snapshot", () => {
  const tree = AmuxRecoveryInspectionView({ m: adminAmuxRecoveryInspectionMessages.en,
    state: { state: "changed" }, onInspect: () => {}, onReloadReview: () => {}, date: (value) => value });
  assert.match(textOf(tree), /task or its latest attempt changed/);
  const button = propsOf(tree).find((props) => props["data-testid"] === "admin-amux-inspect-records");
  assert.equal(button?.disabled, true); assert.doesNotMatch(textOf(tree), /US\$/);
});
test("inspection issues one exact GET and binds status and revision", async () => {
  let url = "";
  const ready = await fetchAmuxRecoveryInspection({ identity, taskStatus: "blocked",
    controller: new AbortController(), isCurrent: () => true, fallback: "unavailable",
    fetcher: async (input, init) => { url = String(input); assert.equal(init?.cache, "no-store");
      assert.equal(init?.method, undefined); return Response.json(fixture()); } });
  assert.equal(ready?.state, "ready");
  const query = new URL(url, "https://tomverse.test").searchParams;
  assert.deepEqual(Object.fromEntries(query), { view: "recovery_inspection", taskId: "task-1", taskRevision: "4", attemptId: "attempt-1" });
  const changed = await fetchAmuxRecoveryInspection({ identity, taskStatus: "doing",
    controller: new AbortController(), isCurrent: () => true, fallback: "unavailable",
    fetcher: async () => Response.json(fixture()) });
  assert.equal(changed?.state, "changed");
});
test("recent authentication refusal retains the existing recovery link notice", async () => {
  const response = await fetchAmuxRecoveryInspection({ identity, taskStatus: "blocked",
    controller: new AbortController(), isCurrent: () => true, fallback: "unavailable",
    fetcher: async () => Response.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428 }) });
  assert.equal(response?.state, "unavailable");
  if (response?.state === "unavailable") assert.equal(response.failure?.requiresReauthentication, true);
});
test("a late inspection body cannot replace a closed or newer review", async () => {
  let current = true; let started!: () => void; let release!: (value: unknown) => void;
  const bodyStarted = new Promise<void>((resolve) => { started = resolve; });
  const body = new Promise<unknown>((resolve) => { release = resolve; });
  const request = fetchAmuxRecoveryInspection({ identity, taskStatus: "blocked", controller: new AbortController(),
    isCurrent: () => current, fallback: "unavailable", fetcher: async () => ({ ok: true, status: 200,
      json: async () => { started(); return body; } }) as Response });
  await bodyStarted; current = false; release(fixture()); assert.equal(await request, null);
});
test("inspection timeout stops loading without inventing records or a cost", async () => {
  const controller = new AbortController();
  const response = await fetchAmuxRecoveryInspection({ identity, taskStatus: "blocked", controller,
    isCurrent: () => true, fallback: "unavailable", timeoutMs: 5,
    fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }) });
  assert.deepEqual(response, { state: "unavailable", failure: null });
  assert.equal(controller.signal.aborted, true); assert.equal(AMUX_RECOVERY_INSPECTION_TIMEOUT_MS, 10_000);
});
const inspectionRequestId = "00000000-0000-4000-8000-000000000001";
const quote = { oldHeldMicroUsd: "3400000", additionalCapMicroUsd: "3400000", worstExposureMicroUsd: "6800000",
  catalogApprovalId: "catalog-approval", catalogVersion: "catalog-v1", pricingVersion: "pricing-v1",
  costReceiptDigest: "b".repeat(64), costDigest: "c".repeat(64) };
const guards = { priorEffects: "unknown" as const, oldCost: "held" as const,
  readOnlyLaunch: "required" as const, taskAttemptLimit: 2 as const };
const normalEligibility = { acceptUnknownPriorEffects: false, requestSafeStop: false,
  approveAttempt: true, reason: null };
const hostFixture = (): AmuxV22RecoveryRead => ({ taskId: identity.taskId, requestId: inspectionRequestId,
  state: "verified", inspectionId: "00000000-0000-4000-8000-000000000002",
  evidenceId: "00000000-0000-4000-8000-000000000003", evidenceDigest: "a".repeat(64),
  reason: null, taskRevision: identity.taskRevision, priorAttemptId: identity.attemptId,
  cost: quote, quote, riskAcceptance: null, launchProof: null,
  eligibility: normalEligibility, guards, retryWrite: false });
const hostView = (data: AmuxHostRecoveryRead, confirmed = false, safeStopConfirmed = false,
  riskConfirmed = false) => AmuxHostRecoveryView({
  m: adminAmuxRecoveryInspectionMessages.ko, state: { state: "ready", data },
  confirmed, onConfirm: () => {}, onRequest: () => {}, onRefresh: () => {}, onApprove: () => {},
  riskConfirmed, onRiskConfirm: () => {}, onAcceptRisk: () => {},
  safeStopConfirmed, onSafeStopConfirm: () => {}, onSafeStop: () => {},
  onReloadReview: () => {}, canRequest: true });
const legacyFixture = (): AmuxHostRecoveryRead => ({ ...hostFixture(), state: "unverified",
  requestKind: "inspect", reason: "legacy_invocation_unbound", recoveryEnabled: true,
  safeStopEnabled: true, eligibility: { acceptUnknownPriorEffects: true, requestSafeStop: false,
    approveAttempt: false, reason: "risk_acceptance_required" } });
const riskAcceptance = { id: "00000000-0000-4000-8000-000000000010", digest: "e".repeat(64),
  ownerRequestId: "00000000-0000-4000-8000-000000000011",
  sourceEvidenceId: legacyFixture().evidenceId!, sourceEvidenceDigest: legacyFixture().evidenceDigest!,
  acceptedAt: "2026-10-13T02:00:00.000Z", oldHeldMicroUsd: "3400000",
  additionalCapMicroUsd: "3400000", worstExposureMicroUsd: "6800000",
  executionStarted: false as const, reservationCreated: false as const };
const acceptedFixture = (requestId = riskAcceptance.ownerRequestId): AmuxHostRecoveryRead => ({
  ...hostFixture(), requestId, state: "pending", inspectionId: null, evidenceId: null,
  evidenceDigest: null, reason: "safe_stop_required", requestKind: undefined,
  riskAcceptance, recoveryEnabled: true, safeStopEnabled: true,
  eligibility: { acceptUnknownPriorEffects: false, requestSafeStop: true,
    approveAttempt: false, reason: "safe_stop_required" },
});
const safeStopFixture = (requestId = inspectionRequestId): AmuxHostRecoveryRead => ({
  ...hostFixture(), requestId, requestKind: "safe_stop", state: "verified", riskAcceptance,
  sourceEvidenceId: legacyFixture().evidenceId, sourceEvidenceDigest: legacyFixture().evidenceDigest,
  workerProfileAlias: "claude-maintenance", profileWorkerNames: ["claude-chore", "claude-security"],
  targetUnit: "tomverse-amux-v22-sidecar@claude-maintenance.service",
  profileConfigDigest: "d".repeat(64), stopAcknowledgement: "outcome_unknown", processState: "gone",
  reason: "safe_stop_process_gone", recoveryEnabled: true, safeStopEnabled: true,
  eligibility: { acceptUnknownPriorEffects: false, requestSafeStop: false,
    approveAttempt: false, reason: "launch_proof_required" } });
const launchProof = { id: "00000000-0000-4000-8000-000000000012", digest: "f".repeat(64),
  launchBindingId: "00000000-0000-4000-8000-000000000013", state: "current" as const,
  workerName: "codex-chore", provider: "openai", modelId: "gpt-6.1-sol", routeId: "read-only-route",
  role: "investigate" as const, briefDigest: "1".repeat(64), pricingVersion: quote.pricingVersion,
  costReceiptDigest: quote.costReceiptDigest, launchScopeVersion: 1 as const };
const launchReadyFixture = (requestId = inspectionRequestId): AmuxHostRecoveryRead => ({
  ...safeStopFixture(requestId), launchProof,
  eligibility: { acceptUnknownPriorEffects: false, requestSafeStop: false,
    approveAttempt: true, reason: null },
});
test("host recovery renders real evidence and derives the held/new/worst exposure confirmation", () => {
  const tree = hostView(hostFixture()); const text = textOf(tree);
  assert.match(text, /US\$3\.40/); assert.match(text, /US\$6\.80/);
  assert.match(text, /이전 작업 프로그램의 종료/);
  assert.match(text, new RegExp(hostFixture().evidenceId!));
  assert.equal(propsOf(tree).find(props => props["data-testid"] === "admin-amux-approve-recovery")?.disabled, true);
  assert.equal(propsOf(hostView(hostFixture(), true)).find(props => props["data-testid"] === "admin-amux-approve-recovery")?.disabled, false);
  for (const state of ["pending", "unverified", "not_visible"] as const) {
    const blocked = hostView({ ...hostFixture(), state, reason: "legacy_invocation_unbound" }, true);
    assert.equal(propsOf(blocked).some(props => props["data-testid"] === "admin-amux-approve-recovery"), false);
  }
});
test("unknown prior effects require a visible default-off acceptance and record no execution or reservation", async () => {
  const initial = hostView(legacyFixture());
  const checkbox = propsOf(initial).find(props => props["data-testid"] === "admin-amux-risk-accept-confirm");
  const button = propsOf(initial).find(props => props["data-testid"] === "admin-amux-accept-unknown-risk");
  assert.equal(checkbox?.checked, false); assert.equal(button?.disabled, true);
  assert.match(textOf(initial), /이전 작업 내용과 실제 공급자 비용은 미확인/);
  assert.match(textOf(initial), /고정된 이전 USD 3\.40, 새 최대 USD 3\.40, 총 상한 USD 6\.80/);
  assert.match(textOf(initial), /현재 catalog 견적을 수락하지 않고/);
  assert.match(textOf(initial), /작업 실행·비용 예약·Task 상태 변경을 하지 않습니다/);
  assert.equal(propsOf(initial).some(props => String(props.className).includes("min-h-11")), true);
  assert.equal(propsOf(hostView(legacyFixture(), false, false, true))
    .find(props => props["data-testid"] === "admin-amux-accept-unknown-risk")?.disabled, false);
  assert.equal(propsOf(hostView({ ...legacyFixture(), cost: null, quote: null }, false, false, true))
    .find(props => props["data-testid"] === "admin-amux-accept-unknown-risk")?.disabled, false);

  const nonce = "00000000-0000-4000-8000-000000000011"; let body: Record<string, unknown> = {};
  const result = await fetchAmuxHostRecovery({ identity, requestId: nonce,
    action: "accept_unknown_prior_effects", displayed: legacyFixture(), controller: new AbortController(),
    isCurrent: () => true, fallback: "unavailable", fetcher: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ ...acceptedFixture(nonce),
        riskAcceptance: { ...riskAcceptance, ownerRequestId: nonce } });
    } });
  assert.equal(result?.state, "ready");
  assert.deepEqual(body, { action: "accept_unknown_prior_effects", taskId: identity.taskId,
    expectedRevision: identity.taskRevision, priorAttemptId: identity.attemptId, requestId: nonce,
    sourceEvidenceId: legacyFixture().evidenceId, sourceEvidenceDigest: legacyFixture().evidenceDigest,
    acceptRisk: true });
  const accepted = textOf(hostView({ ...acceptedFixture(nonce),
    riskAcceptance: { ...riskAcceptance, ownerRequestId: nonce } }));
  assert.match(accepted, /실행을 시작하거나 비용을 예약하지 않았으며/);
  assert.match(accepted, /두 번째 재시도 승인이 아닙니다/);
  assert.equal(propsOf(hostView(acceptedFixture())).some(props =>
    props["data-testid"] === "admin-amux-accept-unknown-risk"), false);
});
test("fixed risk exposure stays separate from a changed or unavailable current quote", async () => {
  const lowerQuote = { ...quote, additionalCapMicroUsd: "1700000",
    worstExposureMicroUsd: "5100000", costDigest: "9".repeat(64) };
  const lower = { ...acceptedFixture(), cost: lowerQuote, quote: lowerQuote };
  assert.ok(bindAmuxHostRecovery(lower, identity, lower.requestId));
  const rendered = textOf(hostView(lower));
  assert.match(rendered, /US\$1\.70/);
  assert.match(rendered, /US\$5\.10/);
  const higherQuote = { ...quote, additionalCapMicroUsd: "4000000",
    worstExposureMicroUsd: "7400000", costDigest: "8".repeat(64) };
  const higher = { ...acceptedFixture(), cost: higherQuote, quote: higherQuote };
  assert.ok(bindAmuxHostRecovery(higher, identity, higher.requestId));
  assert.equal(propsOf(hostView(higher, false, true))
    .find(props => props["data-testid"] === "admin-amux-request-safe-stop")?.disabled, false);

  const nonce = "00000000-0000-4000-8000-000000000014";
  let writes = 0;
  const noQuoteSource = { ...legacyFixture(), cost: null, quote: null };
  const result = await fetchAmuxHostRecovery({ identity, requestId: nonce,
    action: "accept_unknown_prior_effects", displayed: noQuoteSource,
    controller: new AbortController(), isCurrent: () => true, fallback: "unavailable",
    fetcher: async () => { writes += 1; return Response.json({
      ...acceptedFixture(nonce), cost: null, quote: null,
      riskAcceptance: { ...riskAcceptance, ownerRequestId: nonce } }); } });
  assert.equal(result?.state, "ready");
  assert.equal(writes, 1);
  assert.equal(propsOf(hostView({ ...acceptedFixture(nonce), cost: null, quote: null,
    riskAcceptance: { ...riskAcceptance, ownerRequestId: nonce } }, false, true))
    .find(props => props["data-testid"] === "admin-amux-request-safe-stop")?.disabled, false);
});
test("an accepted risk cannot open an unrelated inspection and keeps the safe-stop path", () => {
  const props = propsOf(hostView(acceptedFixture()));
  assert.equal(props.find(value => value["data-testid"] === "admin-amux-request-host-inspection")?.disabled, true);
  assert.equal(props.find(value => value["data-testid"] === "admin-amux-request-safe-stop")?.disabled, true);
  assert.match(textOf(hostView(acceptedFixture(), false, true)), /이전 실행 종료와 확인/);
  assert.equal(propsOf(hostView(acceptedFixture(), false, true))
    .find(value => value["data-testid"] === "admin-amux-request-safe-stop")?.disabled, false);
});
test("host request POST binds the displayed identity and never runs work", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const result = await fetchAmuxHostRecovery({ identity, requestId: inspectionRequestId,
    action: "request_inspection", controller: new AbortController(), isCurrent: () => true,
    fallback: "unavailable", fetcher: async (url, init) => { calls.push({ url: String(url), init: init! });
      return Response.json({ ...hostFixture(), state: "pending", cost: null, quote: null,
        eligibility: { ...normalEligibility, approveAttempt: false, reason: "exact_target_only" } }); } });
  assert.equal(result?.state, "ready"); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/admin/amux/execution-recovery");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { action: "request_inspection",
    taskId: identity.taskId, expectedRevision: identity.taskRevision,
    priorAttemptId: identity.attemptId, requestId: inspectionRequestId });
});
test("safe stop is risk-confirmed, uses only source evidence fields, and keeps stop proof separate", async () => {
  const initial = hostView(legacyFixture()); const text = textOf(initial);
  assert.match(text, /정지한 worker에는 이후 작업도 배정되지 않습니다/);
  assert.match(text, /worker 재개는 별도 운영 절차가 필요합니다/);
  const initialButton = propsOf(initial).find(props => props["data-testid"] === "admin-amux-request-safe-stop");
  assert.equal(initialButton?.disabled, true);
  assert.equal(propsOf(hostView(acceptedFixture(), false, true))
    .find(props => props["data-testid"] === "admin-amux-request-safe-stop")?.disabled, false);

  const nonce = "00000000-0000-4000-8000-000000000008"; let body: Record<string, unknown> = {};
  const result = await fetchAmuxHostRecovery({ identity, requestId: nonce, action: "request_safe_stop",
    displayed: acceptedFixture(), controller: new AbortController(), isCurrent: () => true,
    fallback: "unavailable", fetcher: async (_url, init) => {
      body = JSON.parse(String(init?.body)); return Response.json(safeStopFixture(nonce));
    } });
  assert.equal(result?.state, "ready");
  assert.deepEqual(body, { action: "request_safe_stop", taskId: identity.taskId,
    expectedRevision: identity.taskRevision, priorAttemptId: identity.attemptId, requestId: nonce,
    sourceEvidenceId: legacyFixture().evidenceId, sourceEvidenceDigest: legacyFixture().evidenceDigest });
  assert.equal(Object.hasOwn(body, "targetUnit"), false); assert.equal(Object.hasOwn(body, "workerProfileAlias"), false);
  const resultText = textOf(hostView(safeStopFixture(nonce)));
  assert.match(resultText, /정지 명령 접수 여부는 미확인/);
  assert.match(resultText, /이전 실행 종료는 확인했습니다/);
  assert.match(resultText, /이전 작업 내용과 실제 비용은 확인되지 않았습니다/);
  assert.match(resultText, /이번 종료 요청은 모델을 호출하지 않습니다/);
  assert.match(resultText, /미확인 비용을 0으로 바꾸지 않습니다/);
  assert.doesNotMatch(resultText, /claude-maintenance|profile|fence|PID|v37/);
});

test("safe-stop result refresh is read-only and a mismatched source receipt stays fenced", async () => {
  const nonce = "00000000-0000-4000-8000-000000000008"; let reads = 0, writes = 0;
  const refreshed = await fetchAmuxHostRecovery({ identity, requestId: nonce,
    controller: new AbortController(), isCurrent: () => true, fallback: "unavailable",
    fetcher: async (_url, init) => { if (init?.method) writes += 1; else reads += 1;
      return Response.json(safeStopFixture(nonce)); } });
  assert.equal(refreshed?.state, "ready"); assert.equal(reads, 1); assert.equal(writes, 0);
  const fenced = await fetchAmuxHostRecovery({ identity, requestId: nonce, unknownWrite: true,
    unknownAction: "request_safe_stop", expectedReceipt: {
      sourceEvidenceId: legacyFixture().evidenceId!, sourceEvidenceDigest: legacyFixture().evidenceDigest! },
    controller: new AbortController(), isCurrent: () => true, fallback: "unavailable",
    fetcher: async () => Response.json({ ...safeStopFixture(nonce), sourceEvidenceDigest: "e".repeat(64) }) });
  assert.equal(fenced?.state, "unavailable");
  if (fenced?.state === "unavailable") assert.equal(fenced.unknownWrite, true);
});

test("an explicit safe-stop recheck binds the prior evidence while ordinary refresh remains read-only", async () => {
  const previous = { ...safeStopFixture(), state: "unverified" as const,
    reason: "safe_stop_process_present", processState: "present" as const,
    eligibility: { acceptUnknownPriorEffects: false, requestSafeStop: true,
      approveAttempt: false, reason: "safe_stop_required" as const } };
  const tree = hostView(previous, false, true);
  assert.match(textOf(tree), /종료 상태 새로 확인/);
  assert.equal(propsOf(tree).find(props => props["data-testid"] === "admin-amux-request-safe-stop")?.disabled, false);
  const nonce = "00000000-0000-4000-8000-000000000009"; let body: Record<string, unknown> = {};
  const rechecked = await fetchAmuxHostRecovery({ identity, requestId: nonce, action: "request_safe_stop",
    displayed: previous, controller: new AbortController(), isCurrent: () => true, fallback: "unavailable",
    fetcher: async (_url, init) => { body = JSON.parse(String(init?.body));
      return Response.json(safeStopFixture(nonce)); } });
  assert.equal(rechecked?.state, "ready");
  assert.equal(body.sourceEvidenceId, previous.evidenceId);
  assert.equal(body.sourceEvidenceDigest, previous.evidenceDigest);
  assert.equal(Object.hasOwn(body, "targetUnit"), false);
});
test("lost approval reads the same id once and never repeats the write", async () => {
  const approvalRequestId = "00000000-0000-4000-8000-000000000004";
  let writes = 0, reads = 0;
  const result = await fetchAmuxHostRecovery({ identity, requestId: approvalRequestId,
    action: "approve_attempt", displayed: hostFixture(), controller: new AbortController(),
    isCurrent: () => true, fallback: "unavailable", fetcher: async (url, init) => {
      if (init?.method === "POST") { writes += 1; const body = JSON.parse(String(init.body));
        assert.equal(body.evidenceDigest, "a".repeat(64)); assert.equal(body.costDigest, "c".repeat(64));
        assert.equal(Object.hasOwn(body, "additionalCapMicroUsd"), false); throw new Error("lost response"); }
      reads += 1; assert.equal(new URL(String(url), "https://tomverse.test").searchParams.get("requestId"), approvalRequestId);
      return Response.json({ ...hostFixture(), requestId: approvalRequestId, state: "approved",
        taskRevision: 5, approvalId: "approval-1" });
    } });
  assert.equal(result?.state, "ready"); assert.equal(writes, 1); assert.equal(reads, 1);
  const tree = hostView({ ...hostFixture(), state: "approved", taskRevision: 5, approvalId: "approval-1" });
  assert.match(textOf(tree), /todo/); assert.match(textOf(tree), /아직/);
  assert.equal(propsOf(tree).some(props => props["data-testid"] === "admin-amux-approve-recovery"), false);
});
test("exception approval binds the fresh read-only launch proof and sends only the five exception fields", async () => {
  const displayed = launchReadyFixture(); const tree = hostView(displayed, true);
  assert.match(textOf(tree), /읽기 전용 investigate 시도 정확히 1회/);
  assert.match(textOf(tree), /codex-chore/); assert.match(textOf(tree), /gpt-6\.1-sol/);
  assert.match(textOf(tree), /US\$6\.80/);
  const nonce = "00000000-0000-4000-8000-000000000014"; let body: Record<string, unknown> = {};
  const state = await fetchAmuxHostRecovery({ identity, requestId: nonce, action: "approve_attempt",
    displayed, controller: new AbortController(), isCurrent: () => true, fallback: "unavailable",
    fetcher: async (_url, init) => { body = JSON.parse(String(init?.body));
      return Response.json({ ...displayed, requestId: nonce, state: "approved", taskRevision: 5,
        approvalId: "approval-1", eligibility: { ...displayed.eligibility,
          approveAttempt: false, reason: "already_approved" } }); } });
  assert.equal(state?.state, "ready");
  assert.deepEqual(body, { action: "approve_attempt", taskId: identity.taskId,
    expectedRevision: identity.taskRevision, priorAttemptId: identity.attemptId, requestId: nonce,
    inspectionId: displayed.inspectionId, evidenceId: displayed.evidenceId,
    evidenceDigest: displayed.evidenceDigest, costDigest: displayed.cost!.costDigest,
    riskAcceptanceId: riskAcceptance.id, riskAcceptanceDigest: riskAcceptance.digest,
    launchProofId: launchProof.id, launchProofDigest: launchProof.digest, acceptRetry: true });
  for (const omitted of ["launchBindingId", "workerName", "provider", "modelId", "routeId",
    "briefDigest", "pricingVersion", "costReceiptDigest"]) assert.equal(Object.hasOwn(body, omitted), false);
  const mismatch = await fetchAmuxHostRecovery({ identity, requestId: nonce, unknownWrite: true,
    unknownAction: "approve_attempt",
    expectedReceipt: pendingFixture("approve_attempt", true).expectedReceipt!,
    controller: new AbortController(), isCurrent: () => true, fallback: "unavailable",
    fetcher: async () => Response.json({ ...displayed, requestId: nonce, state: "approved",
      taskRevision: 5, approvalId: "approval-1",
      launchProof: { ...launchProof, modelId: "gpt-6.1-sol-rebound" } }) });
  assert.equal(mismatch?.state, "unavailable");
  if (mismatch?.state === "unavailable") assert.equal(mismatch.unknownWrite, true);
});
test("host 428 offers reauthentication and 409 requires a protected review reload", async () => {
  for (const status of [428, 409]) {
    const result = await fetchAmuxHostRecovery({ identity, requestId: inspectionRequestId,
      action: "request_inspection", controller: new AbortController(), isCurrent: () => true,
      fallback: "unavailable", fetcher: async () => Response.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status }) });
    assert.equal(result?.state, status === 409 ? "changed" : "unavailable");
    if (result?.state === "unavailable") assert.equal(result.failure?.requiresReauthentication, true);
  }
});
test("closed recovery switch remains unavailable rather than claiming the task changed", async () => {
  let calls = 0;
  const result = await fetchAmuxHostRecovery({ identity, requestId: inspectionRequestId,
    action: "request_inspection", controller: new AbortController(), isCurrent: () => true,
    fallback: "unavailable", fetcher: async () => { calls += 1;
      return Response.json({ error: "recovery_disabled" }, { status: 409 }); } });
  assert.equal(result?.state, "unavailable"); assert.equal(calls, 1);
  if (result?.state === "unavailable") assert.equal(result.unknownWrite, false);
  const tree = hostView({ ...hostFixture(), recoveryEnabled: false }, true);
  assert.match(textOf(tree), /현재 비활성/);
  assert.equal(propsOf(tree).some(props => props["data-testid"] === "admin-amux-approve-recovery"), false);
  assert.equal(propsOf(tree).find(props => props["data-testid"] === "admin-amux-request-host-inspection")?.disabled, true);
});
test("reading immutable evidence never sends a fresh inspection or approval", async () => {
  let calls = 0;
  const result = await fetchAmuxHostRecovery({ identity, requestId: inspectionRequestId,
    controller: new AbortController(), isCurrent: () => true, fallback: "unavailable",
    fetcher: async (_url, init) => { calls += 1; assert.equal(init?.method, undefined);
      return Response.json({ ...hostFixture(), state: "unverified", reason: "evidence_stale" }); } });
  assert.equal(result?.state, "ready"); assert.equal(calls, 1);
  if (result?.state === "ready") assert.equal(result.data.reason, "evidence_stale");
  const tree = hostView({ ...hostFixture(), state: "unverified", reason: "evidence_stale" });
  assert.equal(propsOf(tree).some(props => props["data-testid"] === "admin-amux-approve-recovery"), false);
  assert.match(textOf(tree), /새 Ubuntu 증거 요청/);
  assert.match(textOf(tree), /다시 읽어도 기한이 늘어나지/);
});
test("host late and timed-out body cannot restore an approval", async () => {
  const controller = new AbortController();
  const result = await fetchAmuxHostRecovery({ identity, requestId: inspectionRequestId,
    controller, isCurrent: () => true, fallback: "unavailable", timeoutMs: 5,
    fetcher: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as Response });
  assert.equal(result?.state, "unavailable"); assert.equal(controller.signal.aborted, true);
  const stale = await fetchAmuxHostRecovery({ identity, requestId: inspectionRequestId,
    controller: new AbortController(), isCurrent: () => false, fallback: "unavailable",
    fetcher: async () => { throw new Error("must not fetch a closed surface"); } });
  assert.equal(stale, null);
});
test("lost approval and repeated invisible nonce readback keep only exact GET recovery", async () => {
  const nonce = "00000000-0000-4000-8000-000000000005";
  const missing = { taskId: identity.taskId, requestId: nonce, state: "not_visible",
    inspectionId: null, evidenceId: null, evidenceDigest: null, reason: null,
    taskRevision: null, priorAttemptId: null, cost: null, quote: null,
    riskAcceptance: null, launchProof: null,
    eligibility: { ...normalEligibility, approveAttempt: false, reason: "exact_target_only" },
    guards, retryWrite: false };
  let writes = 0, reads = 0;
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") { writes += 1; throw new Error("lost approval"); }
    reads += 1; assert.equal(new URL(String(url), "https://tomverse.test").searchParams.get("requestId"), nonce);
    return Response.json(missing);
  };
  let state = await fetchAmuxHostRecovery({ identity, requestId: nonce, action: "approve_attempt",
    displayed: hostFixture(), controller: new AbortController(), isCurrent: () => true,
    fallback: "unavailable", fetcher });
  assert.equal(state?.state, "unavailable");
  for (let count = 0; count < 2; count += 1) {
    assert.equal(state?.state, "unavailable");
    if (state?.state !== "unavailable") throw new Error("invisible approval must remain unknown");
    assert.equal(state.unknownWrite, true); assert.equal(state.requestId, nonce);
    const tree = AmuxHostRecoveryView({ m: adminAmuxRecoveryInspectionMessages.ko, state,
      confirmed: true, onConfirm: () => {}, onRequest: () => {}, onRefresh: () => {},
      onApprove: () => {}, onReloadReview: () => {}, canRequest: true });
    assert.equal(propsOf(tree).find(props => props["data-testid"] === "admin-amux-request-host-inspection")?.disabled, true);
    assert.equal(propsOf(tree).find(props => props["data-testid"] === "admin-amux-refresh-host-inspection")?.disabled, false);
    assert.equal(propsOf(tree).some(props => props["data-testid"] === "admin-amux-approve-recovery"), false);
    state = await fetchAmuxHostRecovery({ identity, requestId: nonce, unknownWrite: state.unknownWrite,
      unknownAction: state.unknownAction, expectedReceipt: state.expectedReceipt,
      controller: new AbortController(), isCurrent: () => true,
      fallback: "unavailable", fetcher });
  }
  assert.equal(state?.state, "unavailable"); assert.equal(writes, 1); assert.equal(reads, 3);
  if (state?.state !== "unavailable") throw new Error("unknown nonce fence lost");
  const mismatch = await fetchAmuxHostRecovery({ identity, requestId: nonce,
    unknownWrite: state.unknownWrite, unknownAction: state.unknownAction,
    expectedReceipt: state.expectedReceipt, controller: new AbortController(), isCurrent: () => true,
    fallback: "unavailable", fetcher: async () => Response.json({ ...hostFixture(), requestId: nonce,
      state: "approved", taskRevision: 5, approvalId: "approval-1", evidenceDigest: "d".repeat(64) }) });
  assert.equal(mismatch?.state, "unavailable");
  if (mismatch?.state === "unavailable") assert.equal(mismatch.unknownWrite, true);
});
test("unknown nonce refresh preserves its fence through timeout, reauthentication and mismatched body", async () => {
  const nonce = "00000000-0000-4000-8000-000000000005";
  for (const answer of [() => Response.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428 }),
    () => Response.json({ ...hostFixture(), taskId: "another-task", requestId: nonce }),
    () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as Response]) {
    const state = await fetchAmuxHostRecovery({ identity, requestId: nonce, unknownWrite: true,
      unknownAction: "approve_attempt", controller: new AbortController(), isCurrent: () => true,
      fallback: "unavailable", timeoutMs: 5, fetcher: async () => answer() });
    assert.equal(state?.state, "unavailable");
    if (state?.state === "unavailable") { assert.equal(state.unknownWrite, true); assert.equal(state.requestId, nonce); }
  }
  let calls = 0;
  const refused = await fetchAmuxHostRecovery({ identity, requestId: nonce, unknownWrite: true,
    action: "request_inspection", controller: new AbortController(), isCurrent: () => true,
    fallback: "unavailable", fetcher: async () => { calls += 1; return Response.json(hostFixture()); } });
  assert.equal(refused?.state, "unavailable"); assert.equal(calls, 0);
});
test("an inconclusive positive approval reply is read back and never unlocks another write", async () => {
  const nonce = "00000000-0000-4000-8000-000000000005";
  let writes = 0, reads = 0;
  const state = await fetchAmuxHostRecovery({ identity, requestId: nonce, action: "approve_attempt",
    displayed: hostFixture(), controller: new AbortController(), isCurrent: () => true,
    fallback: "unavailable", fetcher: async (_url, init) => {
      if (init?.method === "POST") { writes += 1; return Response.json({ invalid: true }); }
      reads += 1; return Response.json({ taskId: identity.taskId, requestId: nonce, state: "not_visible",
        inspectionId: null, evidenceId: null, evidenceDigest: null, reason: null,
        taskRevision: null, priorAttemptId: null, cost: null, quote: null,
        riskAcceptance: null, launchProof: null,
        eligibility: { ...normalEligibility, approveAttempt: false, reason: "exact_target_only" },
        guards, retryWrite: false });
    } });
  assert.equal(state?.state, "unavailable"); assert.equal(writes, 1); assert.equal(reads, 1);
  if (state?.state === "unavailable") assert.equal(state.unknownWrite, true);
});
test("closed mounted scope ignores a late approval readback without reopening actions", async () => {
  let current = true; let started!: () => void; let release!: (value: unknown) => void;
  const bodyStarted = new Promise<void>(resolve => { started = resolve; });
  const body = new Promise<unknown>(resolve => { release = resolve; });
  const request = fetchAmuxHostRecovery({ identity, requestId: inspectionRequestId, unknownWrite: true,
    unknownAction: "approve_attempt", controller: new AbortController(), isCurrent: () => current,
    fallback: "unavailable", fetcher: async () => ({ ok: true, status: 200,
      json: async () => { started(); return body; } }) as Response });
  await bodyStarted; current = false;
  release({ ...hostFixture(), state: "approved", taskRevision: 5, approvalId: "approval-1" });
  assert.equal(await request, null);
});
test("advanced app task status remains separate from the immutable approval receipt", async () => {
  for (const currentTask of [{ revision: 6, status: "todo" }, { revision: 7, status: "doing" },
    { revision: 8, status: "review" }]) {
    const data = { ...hostFixture(), state: "approved" as const, taskRevision: 5,
      approvalId: "approval-1", currentTask };
    const state = await fetchAmuxHostRecovery({ identity, requestId: inspectionRequestId,
      unknownWrite: true, unknownAction: "approve_attempt", controller: new AbortController(),
      isCurrent: () => true, fallback: "unavailable", fetcher: async () => Response.json(data) });
    assert.equal(state?.state, "ready");
    const text = textOf(hostView(data));
    assert.match(text, /승인 직후 작업 revision/); assert.match(text, /앱에 기록된 현재 작업 상태/);
    assert.match(text, new RegExp(currentTask.status));
    assert.doesNotMatch(text, /CLI 실행 성공|완료됐습니다/);
    assert.equal(propsOf(hostView(data)).some(props => props["data-testid"] === "admin-amux-approve-recovery"), false);
  }
});

// Minimal hook harness for the actual Panel, not a second implementation of
// its request logic. React's installed dispatcher shape is asserted explicitly.
function mountRecoveryPanel(initialIdentity = identity) {
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE:
    { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  assert.ok(internals && "H" in internals, "installed React client dispatcher is required");
  const slots: unknown[] = [];
  const effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>();
  let cursor = 0, dirty = true, mounted = true, taskIdentity = initialIdentity;
  let hostProps!: Parameters<typeof AmuxHostRecoveryView>[0];
  const queued: (() => void)[] = [];
  const dispatcher = {
    useContext: () => ({ locale: "ko", pending: false, setLocale: () => {} }),
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next: unknown) => {
        if (!mounted) return;
        slots[index] = typeof next === "function" ? next(slots[index]) : next; dirty = true;
      }];
    },
    useRef: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect: (create: () => (() => void) | undefined, deps: unknown[]) => {
      const index = cursor++, previous = effects.get(index);
      if (previous && deps.every((value, pos) => Object.is(value, previous.deps[pos]))) return;
      queued.push(() => { previous?.cleanup?.(); effects.set(index, { deps, cleanup: create() }); });
    },
  };
  const render = () => {
    assert.equal(mounted, true); cursor = 0; dirty = false;
    const previous = internals.H; internals.H = dispatcher;
    try {
      const tree = AmuxOwnerRecoveryInspectionPanel({ identity: taskIdentity,
        taskStatus: "blocked", onReloadReview: () => {} });
      hostProps = (tree.props.children[1] as React.ReactElement<Parameters<typeof AmuxHostRecoveryView>[0]>).props;
    } finally { internals.H = previous; }
    queued.splice(0).forEach(create => create());
  };
  const flush = async () => {
    for (let turn = 0; turn < 32; turn += 1) { if (dirty && mounted) render(); await Promise.resolve(); }
    if (dirty && mounted) render();
  };
  render();
  return { flush, get props() { return hostProps; }, get view() { return AmuxHostRecoveryView(hostProps); },
    replace: async (next: typeof identity) => { taskIdentity = next; dirty = true; await flush(); },
    unmount: () => { effects.forEach(effect => effect.cleanup?.()); mounted = false; },
  };
}
const pendingFixture = (action: AmuxPendingRecovery["action"] = "approve_attempt",
  exceptional = false): AmuxPendingRecovery => ({
  version: 1, identity, requestId: "00000000-0000-4000-8000-000000000005", action,
  expectedReceipt: action === "approve_attempt" ? { inspectionId: hostFixture().inspectionId,
    evidenceId: hostFixture().evidenceId, evidenceDigest: hostFixture().evidenceDigest,
    costDigest: hostFixture().cost!.costDigest, ...(exceptional ? {
      riskAcceptanceId: riskAcceptance.id, riskAcceptanceDigest: riskAcceptance.digest,
      launchProofId: launchProof.id, launchProofDigest: launchProof.digest,
      launchBindingId: launchProof.launchBindingId, workerName: launchProof.workerName,
      provider: launchProof.provider, modelId: launchProof.modelId, routeId: launchProof.routeId,
      briefDigest: launchProof.briefDigest, pricingVersion: launchProof.pricingVersion,
      costReceiptDigest: launchProof.costReceiptDigest,
    } : {}) } : action === "request_safe_stop" || action === "accept_unknown_prior_effects" ? {
    sourceEvidenceId: legacyFixture().evidenceId!, sourceEvidenceDigest: legacyFixture().evidenceDigest!,
    ...(action === "request_safe_stop" ? { riskAcceptanceId: riskAcceptance.id,
      riskAcceptanceDigest: riskAcceptance.digest } : {}),
  } : null });
const missingRecovery = (taskId: string, requestId: string) => ({ taskId, requestId, state: "not_visible",
  inspectionId: null, evidenceId: null, evidenceDigest: null, reason: null,
  taskRevision: null, priorAttemptId: null, cost: null, quote: null,
  riskAcceptance: null, launchProof: null,
  eligibility: { ...normalEligibility, approveAttempt: false, reason: "exact_target_only" },
  guards, retryWrite: false });
function recoveryBrowser(t: TestContext) {
  const values = new Map<string, string>();
  const sessionStorage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window"); });
  return { values, sessionStorage };
}

test("actual Panel clears final consent when the server reports a changed launch binding", async t => {
  recoveryBrowser(t); let requestId = "", writes = 0, reads = 0;
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes += 1; const body = JSON.parse(String(init.body)); requestId = body.requestId;
      return Response.json({ ...launchReadyFixture(requestId), requestId });
    }
    reads += 1; assert.equal(new URL(String(url), "https://tomverse.test").searchParams.get("requestId"), requestId);
    return Response.json({ ...launchReadyFixture(requestId),
      launchProof: { ...launchProof, state: "mismatch", modelId: "gpt-6.1-sol-rebound" },
      eligibility: { acceptUnknownPriorEffects: false, requestSafeStop: false,
        approveAttempt: false, reason: "binding_changed" } });
  });
  const panel = mountRecoveryPanel(); await panel.flush(); panel.props.onRequest(); await panel.flush();
  panel.props.onConfirm(true); await panel.flush();
  assert.equal(propsOf(panel.view).find(props => props["data-testid"] === "admin-amux-approve-recovery")?.disabled, false);
  panel.props.onRefresh(); await panel.flush();
  assert.equal(panel.props.confirmed, false);
  assert.equal(propsOf(panel.view).some(props => props["data-testid"] === "admin-amux-approve-recovery"), false);
  assert.match(textOf(panel.view), /원본·모델·가격 또는 의존성 결속이 바뀌었습니다/);
  assert.equal(writes, 1); assert.equal(reads, 1); panel.unmount();
});

test("actual Panel preserves lost POST nonce across close, remount and page reload", async t => {
  const browser = recoveryBrowser(t); let writes = 0; const readIds: string[] = [];
  let nonce = "";
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes += 1; nonce = JSON.parse(String(init.body)).requestId;
      const stored = readAmuxPendingRecovery(identity.taskId);
      assert.equal(stored.state, "pending", "the marker must exist before POST");
      if (stored.state === "pending") assert.equal(stored.pending.requestId, nonce);
      throw new Error("lost answer");
    }
    const query = new URL(String(url), "https://tomverse.test").searchParams;
    readIds.push(query.get("requestId")!); return Response.json(missingRecovery(identity.taskId, nonce));
  });
  let panel = mountRecoveryPanel(); await panel.flush(); panel.props.onRequest(); await panel.flush();
  assert.equal(writes, 1); assert.equal(panel.props.state.state, "unavailable"); panel.unmount();
  // Both closing/reopening and a page refresh create new hooks and refs while
  // the tab's sessionStorage survives. Neither may create a second nonce.
  for (let reopen = 0; reopen < 2; reopen += 1) {
    panel = mountRecoveryPanel(); await panel.flush();
    assert.equal(panel.props.writesBlocked, true); panel.props.onRequest(); await panel.flush();
    assert.equal(writes, 1); panel.props.onRefresh(); await panel.flush(); panel.unmount();
  }
  assert.deepEqual(readIds, [nonce, nonce, nonce]); assert.equal(browser.values.size, 1);
  const raw = [...browser.values.values()][0];
  assert.doesNotMatch(raw, /oldHeldMicroUsd|additionalCapMicroUsd|prompt|secret|resolution/);
});

test("actual Panel releases the marker of a POST the server refused outright, never an unknown one", async t => {
  for (const [status, released] of [[409, true], [428, true], [429, true], [503, false]] as const) {
    const browser = recoveryBrowser(t); let writes = 0, reads = 0;
    const nonces: string[] = [];
    const fetchMock = t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes += 1; nonces.push(JSON.parse(String(init.body)).requestId);
        assert.equal(readAmuxPendingRecovery(identity.taskId).state, "pending",
          "the marker must exist before POST");
        return Response.json({ error: status === 409 ? "recovery_evidence_stale" :
          status === 428 ? "ADMIN_REAUTHENTICATION_REQUIRED" : "busy" }, { status });
      }
      // Only an unknown outcome reads the same nonce back; it stays unresolved.
      reads += 1; return Response.json({ error: "recovery_evidence_stale" }, { status: 409 });
    });
    const panel = mountRecoveryPanel(); await panel.flush();
    panel.props.onRequest(); await panel.flush();
    assert.equal(writes, 1, `${status}`);
    assert.equal(browser.values.size, released ? 0 : 1, `${status} marker`);
    assert.equal(panel.props.writesBlocked, !released, `${status} writes`);
    assert.equal(reads, released ? 0 : 1, `${status} reads`);
    panel.props.onRequest(); await panel.flush();
    assert.equal(writes, released ? 2 : 1, `${status} next write`);
    if (released) assert.notEqual(nonces[1], nonces[0], "a new request gets a new nonce");
    panel.unmount(); fetchMock.mock.restore();
  }
});

test("actual Panel preserves a lost risk-acceptance nonce and only reads it after remount", async t => {
  const browser = recoveryBrowser(t); let inspectionWrites = 0, acceptanceWrites = 0, acceptanceNonce = "";
  const readIds: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.action === "request_inspection") {
        inspectionWrites += 1; return Response.json({ ...legacyFixture(), requestId: body.requestId });
      }
      assert.equal(body.action, "accept_unknown_prior_effects"); acceptanceWrites += 1;
      acceptanceNonce = body.requestId;
      const stored = readAmuxPendingRecovery(identity.taskId);
      assert.equal(stored.state, "pending");
      if (stored.state === "pending") {
        assert.equal(stored.pending.action, "accept_unknown_prior_effects");
        assert.deepEqual(stored.pending.expectedReceipt,
          pendingFixture("accept_unknown_prior_effects").expectedReceipt);
      }
      throw new Error("lost risk-acceptance answer");
    }
    const query = new URL(String(url), "https://tomverse.test").searchParams;
    readIds.push(query.get("requestId")!);
    return Response.json(missingRecovery(identity.taskId, acceptanceNonce));
  });
  let panel = mountRecoveryPanel(); await panel.flush(); panel.props.onRequest(); await panel.flush();
  panel.props.onRiskConfirm?.(true); await panel.flush(); panel.props.onAcceptRisk?.(); await panel.flush();
  assert.equal(inspectionWrites, 1); assert.equal(acceptanceWrites, 1); assert.equal(browser.values.size, 1);
  panel.unmount(); panel = mountRecoveryPanel(); await panel.flush();
  assert.equal(panel.props.writesBlocked, true); assert.equal(panel.props.riskConfirmed, false);
  panel.props.onAcceptRisk?.(); await panel.flush(); assert.equal(acceptanceWrites, 1);
  panel.props.onRefresh(); await panel.flush(); assert.equal(acceptanceWrites, 1); panel.unmount();
  assert.deepEqual(readIds, [acceptanceNonce, acceptanceNonce]);
});

test("actual Panel resumes a confirmed risk after remount with one fresh GET and no write", async t => {
  const browser = recoveryBrowser(t);
  let inspectionWrites = 0, acceptanceWrites = 0, resumeReads = 0;
  let acceptanceNonce = "", resumeNonce = "";
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.action === "request_inspection") {
        inspectionWrites += 1;
        return Response.json({ ...legacyFixture(), requestId: body.requestId });
      }
      assert.equal(body.action, "accept_unknown_prior_effects");
      acceptanceWrites += 1; acceptanceNonce = body.requestId;
      return Response.json({ ...acceptedFixture(body.requestId),
        riskAcceptance: { ...riskAcceptance, ownerRequestId: body.requestId } });
    }
    resumeReads += 1;
    resumeNonce = new URL(String(url), "https://tomverse.test").searchParams.get("requestId")!;
    assert.notEqual(resumeNonce, acceptanceNonce);
    return Response.json({ ...acceptedFixture(resumeNonce), requestId: resumeNonce,
      riskAcceptance: { ...riskAcceptance, ownerRequestId: acceptanceNonce } });
  });
  let panel = mountRecoveryPanel(); await panel.flush(); panel.props.onRequest(); await panel.flush();
  panel.props.onRiskConfirm?.(true); await panel.flush(); panel.props.onAcceptRisk?.(); await panel.flush();
  assert.equal(inspectionWrites, 1); assert.equal(acceptanceWrites, 1);
  assert.equal(browser.values.size, 1);
  const storedBeforeRemount = [...browser.values.entries()];
  panel.unmount(); panel = mountRecoveryPanel(); await panel.flush();
  assert.equal(resumeReads, 1); assert.equal(inspectionWrites, 1); assert.equal(acceptanceWrites, 1);
  assert.deepEqual([...browser.values.entries()], storedBeforeRemount);
  assert.equal(panel.props.state.state, "ready");
  if (panel.props.state.state === "ready") {
    assert.equal(panel.props.state.data.requestId, resumeNonce);
    assert.equal(panel.props.state.data.riskAcceptance?.ownerRequestId, acceptanceNonce);
  }
  assert.equal(propsOf(panel.view).some(props =>
    props["data-testid"] === "admin-amux-request-safe-stop"), true);
  panel.unmount();
});

test("actual Panel preserves a lost safe-stop receipt across remount and refresh without another stop write", async t => {
  const browser = recoveryBrowser(t); let inspectionWrites = 0, acceptanceWrites = 0, stopWrites = 0, safeNonce = "";
  const readIds: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.action === "request_inspection") {
        inspectionWrites += 1; return Response.json({ ...legacyFixture(), requestId: body.requestId });
      }
      if (body.action === "accept_unknown_prior_effects") {
        acceptanceWrites += 1; return Response.json({ ...acceptedFixture(body.requestId),
          riskAcceptance: { ...riskAcceptance, ownerRequestId: body.requestId } });
      }
      assert.equal(body.action, "request_safe_stop"); stopWrites += 1; safeNonce = body.requestId;
      const marker = readAmuxPendingRecovery(identity.taskId);
      assert.equal(marker.state, "pending");
      if (marker.state === "pending") {
        assert.equal(marker.pending.action, "request_safe_stop");
        assert.deepEqual(marker.pending.expectedReceipt, pendingFixture("request_safe_stop").expectedReceipt);
      }
      throw new Error("lost safe-stop answer");
    }
    const query = new URL(String(url), "https://tomverse.test").searchParams;
    readIds.push(query.get("requestId")!); return Response.json(missingRecovery(identity.taskId, safeNonce));
  });
  let panel = mountRecoveryPanel(); await panel.flush(); panel.props.onRequest(); await panel.flush();
  assert.equal(inspectionWrites, 1); assert.equal(browser.values.size, 0);
  panel.props.onRiskConfirm?.(true); await panel.flush(); panel.props.onAcceptRisk?.(); await panel.flush();
  assert.equal(acceptanceWrites, 1); assert.equal(browser.values.size, 1);
  panel.props.onSafeStopConfirm?.(true); await panel.flush(); panel.props.onSafeStop?.(); await panel.flush();
  assert.equal(stopWrites, 1); assert.equal(browser.values.size, 2); panel.unmount();

  panel = mountRecoveryPanel(); await panel.flush();
  assert.equal(panel.props.writesBlocked, true); assert.equal(panel.props.safeStopConfirmed, false);
  panel.props.onSafeStop?.(); await panel.flush(); assert.equal(stopWrites, 1);
  panel.props.onRefresh(); await panel.flush(); assert.equal(stopWrites, 1); panel.unmount();
  assert.deepEqual(readIds, [safeNonce, safeNonce]);
  const raw = [...browser.values.values()].find(value => value.includes("request_safe_stop"))!;
  assert.match(raw, /request_safe_stop/);
  assert.doesNotMatch(raw, /workerProfileAlias|targetUnit|profileConfigDigest|oldHeldMicroUsd|additionalCapMicroUsd/);
});

test("actual Panel persists exact approval receipt binding before POST and keeps it after unmount", async t => {
  const browser = recoveryBrowser(t); let writes = 0, approvalNonce = "";
  let release!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes += 1; const body = JSON.parse(String(init.body));
      if (body.action === "request_inspection") return Response.json({ ...launchReadyFixture(), requestId: body.requestId });
      approvalNonce = body.requestId;
      const marker = readAmuxPendingRecovery(identity.taskId);
      assert.equal(marker.state, "pending");
      if (marker.state === "pending") {
        assert.equal(marker.pending.action, "approve_attempt");
        assert.deepEqual(marker.pending.expectedReceipt, pendingFixture("approve_attempt", true).expectedReceipt);
      }
      return new Promise<Response>(resolve => { release = resolve; });
    }
    return Response.json(missingRecovery(identity.taskId, approvalNonce));
  });
  let panel = mountRecoveryPanel(); await panel.flush(); panel.props.onRequest(); await panel.flush();
  assert.equal(browser.values.size, 0, "confirmed inspection may clear its own pending marker");
  panel.props.onConfirm(true); await panel.flush(); panel.props.onApprove(); await panel.flush();
  assert.equal(writes, 2); assert.equal(browser.values.size, 1); panel.unmount();
  release(Response.json({ ...launchReadyFixture(approvalNonce), state: "approved", taskRevision: 5,
    approvalId: "approval-1" })); await panel.flush();
  assert.equal(browser.values.size, 1, "a closed Panel must not consume a late reply");
  panel = mountRecoveryPanel(); await panel.flush(); panel.props.onRequest(); panel.props.onApprove();
  await panel.flush(); assert.equal(writes, 2); panel.props.onRefresh(); await panel.flush();
  assert.equal(panel.props.state.state, "unavailable"); assert.equal(browser.values.size, 1); panel.unmount();
});

test("actual Panel binds old revision readback without attaching its marker to another Task", async t => {
  recoveryBrowser(t); const pending = pendingFixture("request_inspection"); saveAmuxPendingRecovery(pending);
  const queries: URLSearchParams[] = []; let writes = 0;
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") { writes += 1;
      const body = JSON.parse(String(init.body));
      return Response.json({ ...hostFixture(), taskId: body.taskId, priorAttemptId: body.priorAttemptId,
        taskRevision: body.expectedRevision, requestId: body.requestId, state: "pending", cost: null }); }
    const query = new URL(String(url), "https://tomverse.test").searchParams; queries.push(query);
    return Response.json(missingRecovery(identity.taskId, pending.requestId));
  });
  const panel = mountRecoveryPanel({ ...identity, taskRevision: 8, attemptId: "attempt-new" }); await panel.flush();
  panel.props.onRequest(); await panel.flush(); assert.equal(writes, 0);
  panel.props.onRefresh(); await panel.flush();
  assert.equal(queries[0].get("requestId"), pending.requestId); assert.equal(queries[0].get("taskId"), identity.taskId);
  await panel.replace({ ...identity, taskId: "task-2" });
  assert.equal(panel.props.writesBlocked, false); panel.props.onRequest(); await panel.flush(); assert.equal(writes, 1);
  assert.equal(readAmuxPendingRecovery(identity.taskId).state, "pending"); panel.unmount();
});

test("actual Panel blocks writes for denied, failed, silently lost and malformed storage", async t => {
  const browser = recoveryBrowser(t); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return Response.json(hostFixture()); });
  const originalGet = browser.sessionStorage.getItem, originalSet = browser.sessionStorage.setItem;
  const modes = ["denied", "failed", "silent", "invalid", "wrong_task"];
  for (const mode of modes) {
    browser.values.clear(); browser.sessionStorage.getItem = originalGet; browser.sessionStorage.setItem = originalSet;
    if (mode === "denied") browser.sessionStorage.getItem = () => { throw new Error("storage denied"); };
    if (mode === "failed") browser.sessionStorage.setItem = () => { throw new Error("storage full"); };
    if (mode === "silent") browser.sessionStorage.setItem = () => {};
    if (mode === "invalid") browser.values.set(`amux-task-recovery-pending-v1:${identity.taskId}`, "invalid");
    if (mode === "wrong_task") browser.values.set(`amux-task-recovery-pending-v1:${identity.taskId}`,
      JSON.stringify({ ...pendingFixture(), identity: { ...identity, taskId: "task-2" } }));
    const panel = mountRecoveryPanel(); await panel.flush(); panel.props.onRequest(); await panel.flush();
    assert.equal(calls, 0, mode); assert.equal(panel.props.writesBlocked, true, mode); panel.unmount();
  }
});

test("actual Panel clears only the exact approved receipt and preserves 428 or mismatched evidence", async t => {
  const browser = recoveryBrowser(t), pending = pendingFixture(); saveAmuxPendingRecovery(pending);
  let answer = "428", calls = 0;
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    calls += 1; assert.equal(init?.method, undefined);
    assert.equal(new URL(String(url), "https://tomverse.test").searchParams.get("requestId"), pending.requestId);
    if (answer === "428") return Response.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428 });
    return Response.json({ ...hostFixture(), requestId: pending.requestId, state: "approved", taskRevision: 5,
      approvalId: "approval-1", evidenceDigest: answer === "mismatch" ? "d".repeat(64) : hostFixture().evidenceDigest });
  });
  const panel = mountRecoveryPanel(); await panel.flush();
  for (const current of ["428", "mismatch", "confirmed"]) {
    answer = current; panel.props.onRefresh(); await panel.flush();
    assert.equal(browser.values.size, current === "confirmed" ? 0 : 1);
    assert.equal(panel.props.writesBlocked, current !== "confirmed");
  }
  assert.equal(calls, 3); assert.equal(panel.props.state.state, "ready"); panel.unmount();
});

test("actual Panel timeout and denied removal retain the same nonce read fence", async t => {
  const browser = recoveryBrowser(t), pending = pendingFixture(); saveAmuxPendingRecovery(pending);
  const realTimeout = setTimeout;
  t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) =>
    realTimeout(args[0], args[1] === AMUX_RECOVERY_INSPECTION_TIMEOUT_MS ? 1 : args[1]));
  let answer = "timeout", calls = 0;
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    calls += 1; assert.equal(init?.method, undefined);
    assert.equal(new URL(String(url), "https://tomverse.test").searchParams.get("requestId"), pending.requestId);
    if (answer === "timeout") return new Promise<Response>(() => {});
    return Response.json({ ...hostFixture(), requestId: pending.requestId, state: "approved", taskRevision: 5,
      approvalId: "approval-1" });
  });
  let panel = mountRecoveryPanel(); await panel.flush(); panel.props.onRefresh();
  await new Promise(resolve => realTimeout(resolve, 10)); await panel.flush();
  assert.equal(panel.props.state.state, "unavailable"); assert.equal(browser.values.size, 1); panel.unmount();
  answer = "confirmed"; browser.sessionStorage.removeItem = () => { throw new Error("removal denied"); };
  panel = mountRecoveryPanel(); await panel.flush(); panel.props.onRefresh(); await panel.flush();
  assert.equal(browser.values.size, 1); assert.equal(panel.props.writesBlocked, true);
  panel.props.onRequest(); await panel.flush(); assert.equal(calls, 2); panel.unmount();
});

test("pending metadata accepts no arbitrary fields and cannot clear another nonce", () => {
  const values = new Map<string, string>();
  const access = () => ({ getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
  const pending = pendingFixture(); assert.ok(bindAmuxPendingRecovery(pending, identity.taskId));
  assert.ok(bindAmuxPendingRecovery(pendingFixture("accept_unknown_prior_effects"), identity.taskId));
  assert.ok(bindAmuxPendingRecovery(pendingFixture("approve_attempt", true), identity.taskId));
  const exceptional = pendingFixture("approve_attempt", true);
  assert.equal(bindAmuxPendingRecovery({ ...exceptional, expectedReceipt: {
    ...(exceptional.expectedReceipt as Record<string, unknown>), launchProofDigest: undefined,
  } }, identity.taskId), null);
  assert.equal(bindAmuxPendingRecovery({ ...pending, cost: hostFixture().cost }, identity.taskId), null);
  assert.equal(saveAmuxPendingRecovery(pending, access).state, "pending");
  assert.equal(clearAmuxPendingRecovery({ ...pending, requestId: inspectionRequestId }, access), false);
  assert.equal(readAmuxPendingRecovery(identity.taskId, access).state, "pending");
  assert.equal(clearAmuxPendingRecovery(pending, access), true);
});

test("actual Panel reads pending host evidence back by itself and stops after its budget", async t => {
  recoveryBrowser(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reads = 0;
  const waiting = (requestId: string) => ({ ...safeStopFixture(requestId), launchProof: null });
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json(waiting(JSON.parse(String(init.body)).requestId));
    reads += 1;
    return Response.json(waiting(new URL(String(url), "https://tomverse.test").searchParams.get("requestId")!));
  });
  const panel = mountRecoveryPanel(); await panel.flush(); panel.props.onRequest(); await panel.flush();
  assert.equal(reads, 0);
  for (let tick = 0; tick < 3; tick += 1) {
    t.mock.timers.tick(AMUX_HOST_EVIDENCE_AUTO_READ_MS); await panel.flush(); }
  assert.equal(reads, 3, "pending evidence is read without a click");
  // Every read passes through "loading"; the budget still ends the polling.
  for (let tick = 0; tick < 100; tick += 1) {
    t.mock.timers.tick(AMUX_HOST_EVIDENCE_AUTO_READ_MS); await panel.flush(); }
  assert.equal(reads, AMUX_HOST_EVIDENCE_AUTO_READS);
  panel.unmount();
});

test("pending host evidence is read back automatically within the owner read limit", async () => {
  // The route allows an owner 20 reads a minute; leave room for manual reads.
  assert.ok(60_000 / AMUX_HOST_EVIDENCE_AUTO_READ_MS <= 12);
  // Long enough to cover a controller tick (60 s) plus a bridge tick (30 s).
  assert.ok(AMUX_HOST_EVIDENCE_AUTO_READ_MS * AMUX_HOST_EVIDENCE_AUTO_READS >= 120_000);
});
