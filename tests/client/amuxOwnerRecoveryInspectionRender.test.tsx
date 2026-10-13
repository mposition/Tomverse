import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React, { type ReactNode } from "react";
import { AmuxRecoveryInspectionView, fetchAmuxRecoveryInspection,
  AMUX_RECOVERY_INSPECTION_TIMEOUT_MS, AmuxHostRecoveryView, fetchAmuxHostRecovery,
  AmuxOwnerRecoveryInspectionPanel } from "@/components/admin/AmuxOwnerRecoveryInspectionPanel";
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
const hostFixture = (): AmuxV22RecoveryRead => ({ taskId: identity.taskId, requestId: inspectionRequestId,
  state: "verified", inspectionId: "00000000-0000-4000-8000-000000000002",
  evidenceId: "00000000-0000-4000-8000-000000000003", evidenceDigest: "a".repeat(64),
  reason: null, taskRevision: identity.taskRevision, priorAttemptId: identity.attemptId,
  cost: { oldHeldMicroUsd: "3400000", additionalCapMicroUsd: "3400000", worstExposureMicroUsd: "6800000",
    catalogApprovalId: "catalog-approval", catalogVersion: "catalog-v1", pricingVersion: "pricing-v1",
    costReceiptDigest: "b".repeat(64), costDigest: "c".repeat(64) }, retryWrite: false });
const hostView = (data: AmuxHostRecoveryRead, confirmed = false) => AmuxHostRecoveryView({
  m: adminAmuxRecoveryInspectionMessages.ko, state: { state: "ready", data },
  confirmed, onConfirm: () => {}, onRequest: () => {}, onRefresh: () => {}, onApprove: () => {},
  onReloadReview: () => {}, canRequest: true });
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
test("host request POST binds the displayed identity and never runs work", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const result = await fetchAmuxHostRecovery({ identity, requestId: inspectionRequestId,
    action: "request_inspection", controller: new AbortController(), isCurrent: () => true,
    fallback: "unavailable", fetcher: async (url, init) => { calls.push({ url: String(url), init: init! });
      return Response.json({ ...hostFixture(), state: "pending", cost: null }); } });
  assert.equal(result?.state, "ready"); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/admin/amux/execution-recovery");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { action: "request_inspection",
    taskId: identity.taskId, expectedRevision: identity.taskRevision,
    priorAttemptId: identity.attemptId, requestId: inspectionRequestId });
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
    taskRevision: null, priorAttemptId: null, cost: null, retryWrite: false };
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
        taskRevision: null, priorAttemptId: null, cost: null, retryWrite: false });
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
const pendingFixture = (action: AmuxPendingRecovery["action"] = "approve_attempt"): AmuxPendingRecovery => ({
  version: 1, identity, requestId: "00000000-0000-4000-8000-000000000005", action,
  expectedReceipt: action === "approve_attempt" ? { inspectionId: hostFixture().inspectionId,
    evidenceId: hostFixture().evidenceId, evidenceDigest: hostFixture().evidenceDigest,
    costDigest: hostFixture().cost!.costDigest } : null });
const missingRecovery = (taskId: string, requestId: string) => ({ taskId, requestId, state: "not_visible",
  inspectionId: null, evidenceId: null, evidenceDigest: null, reason: null,
  taskRevision: null, priorAttemptId: null, cost: null, retryWrite: false });
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

test("actual Panel persists exact approval receipt binding before POST and keeps it after unmount", async t => {
  const browser = recoveryBrowser(t); let writes = 0, approvalNonce = "";
  let release!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes += 1; const body = JSON.parse(String(init.body));
      if (body.action === "request_inspection") return Response.json({ ...hostFixture(), requestId: body.requestId });
      approvalNonce = body.requestId;
      const marker = readAmuxPendingRecovery(identity.taskId);
      assert.equal(marker.state, "pending");
      if (marker.state === "pending") {
        assert.equal(marker.pending.action, "approve_attempt");
        assert.deepEqual(marker.pending.expectedReceipt, pendingFixture().expectedReceipt);
      }
      return new Promise<Response>(resolve => { release = resolve; });
    }
    return Response.json(missingRecovery(identity.taskId, approvalNonce));
  });
  let panel = mountRecoveryPanel(); await panel.flush(); panel.props.onRequest(); await panel.flush();
  assert.equal(browser.values.size, 0, "confirmed inspection may clear its own pending marker");
  panel.props.onConfirm(true); await panel.flush(); panel.props.onApprove(); await panel.flush();
  assert.equal(writes, 2); assert.equal(browser.values.size, 1); panel.unmount();
  release(Response.json({ ...hostFixture(), requestId: approvalNonce, state: "approved", taskRevision: 5,
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
  assert.equal(bindAmuxPendingRecovery({ ...pending, cost: hostFixture().cost }, identity.taskId), null);
  assert.equal(saveAmuxPendingRecovery(pending, access).state, "pending");
  assert.equal(clearAmuxPendingRecovery({ ...pending, requestId: inspectionRequestId }, access), false);
  assert.equal(readAmuxPendingRecovery(identity.taskId, access).state, "pending");
  assert.equal(clearAmuxPendingRecovery(pending, access), true);
});
