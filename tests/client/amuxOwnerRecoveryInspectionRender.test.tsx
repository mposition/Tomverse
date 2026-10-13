import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";
import { AmuxRecoveryInspectionView, fetchAmuxRecoveryInspection,
  AMUX_RECOVERY_INSPECTION_TIMEOUT_MS } from "@/components/admin/AmuxOwnerRecoveryInspectionPanel";
import { adminAmuxRecoveryInspectionMessages } from "@/lib/adminMessages/amuxRecoveryInspection";
import { summarizeAmuxRecoveryUsage, type AmuxOwnerRecoveryInspection } from
  "@/lib/amux/ownerRecoveryInspectionCore";

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
