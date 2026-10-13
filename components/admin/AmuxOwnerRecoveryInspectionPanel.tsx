"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { AdminApiFailureNotice } from "./AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "./AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminIntlLocale, type AdminMessageShape } from "@/lib/adminLocale";
import { adminAmuxRecoveryInspectionMessages } from "@/lib/adminMessages/amuxRecoveryInspection";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { bindAmuxRecoveryInspection, type AmuxOwnerRecoveryInspection,
  type AmuxRecoveryInspectionIdentity } from "@/lib/amux/ownerRecoveryInspectionCore";
import type { AmuxV22RecoveryRead } from "@/lib/amux/v22TaskRecoveryCore";
import { clearAmuxPendingRecovery, readAmuxPendingRecovery, saveAmuxPendingRecovery,
  type AmuxPendingRecovery, type AmuxPendingRecoveryLoad, type RecoveryAction,
  type RecoveryReceiptBinding } from "@/lib/amux/ownerRecoveryPending";
export type AmuxHostRecoveryRead = AmuxV22RecoveryRead & { recoveryEnabled?: boolean };

export const AMUX_RECOVERY_INSPECTION_TIMEOUT_MS = 10_000;
type Messages = AdminMessageShape<(typeof adminAmuxRecoveryInspectionMessages)["en"]>;
export type AmuxRecoveryInspectionState =
  | { state: "idle" | "loading" | "changed" }
  | { state: "unavailable"; failure: AdminApiFailure | null }
  | { state: "ready"; inspection: AmuxOwnerRecoveryInspection };
export type AmuxHostRecoveryState =
  | { state: "idle" | "loading" }
  | { state: "changed"; reason?: string | null }
  | { state: "unavailable"; failure: AdminApiFailure | null; requestId: string; unknownWrite: boolean;
      unknownAction?: RecoveryAction; expectedReceipt?: RecoveryReceiptBinding }
  | { state: "ready"; data: AmuxHostRecoveryRead };

const record = (value: unknown): value is Record<string, unknown> => value !== null &&
  typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const money = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value);
export function bindAmuxHostRecovery(value: unknown, identity: AmuxRecoveryInspectionIdentity,
  requestId: string): AmuxHostRecoveryRead | null {
  if (!record(value) || value.taskId !== identity.taskId || value.requestId !== requestId ||
      value.retryWrite !== false || (value.reason !== null &&
        (typeof value.reason !== "string" || !/^[A-Za-z0-9_]{1,128}$/.test(value.reason))) ||
      (value.recoveryEnabled !== undefined && typeof value.recoveryEnabled !== "boolean") ||
      !["pending", "unverified", "verified", "approved", "not_visible"].includes(String(value.state))) return null;
  if (value.currentTask !== undefined && value.currentTask !== null &&
      (!record(value.currentTask) || Object.keys(value.currentTask).sort().join(",") !== "revision,status" ||
       !Number.isSafeInteger(value.currentTask.revision) || Number(value.currentTask.revision) < 0 ||
       Number(value.currentTask.revision) > 2_147_483_647 ||
       !["backlog", "todo", "doing", "review", "blocked", "done", "cancelled"].includes(String(value.currentTask.status)))) return null;
  if (value.state === "not_visible") return value.inspectionId === null && value.evidenceId === null &&
    value.evidenceDigest === null && value.cost === null ? value as AmuxHostRecoveryRead : null;
  if (!uuid(value.inspectionId) || value.priorAttemptId !== identity.attemptId ||
      value.taskRevision !== identity.taskRevision + (value.state === "approved" ? 1 : 0) ||
      (value.evidenceId !== null && !uuid(value.evidenceId)) ||
      (value.evidenceDigest !== null && !digest(value.evidenceDigest))) return null;
  if (["verified", "approved"].includes(String(value.state)) &&
      (!uuid(value.evidenceId) || !digest(value.evidenceDigest) || !record(value.cost))) return null;
  if (value.state === "approved" && (typeof value.approvalId !== "string" || !value.approvalId)) return null;
  if (value.cost !== null) {
    if (!record(value.cost)) return null;
    const cost = value.cost;
    if (!money(cost.oldHeldMicroUsd) || !money(cost.additionalCapMicroUsd) ||
        !money(cost.worstExposureMicroUsd) || BigInt(cost.additionalCapMicroUsd) <= BigInt(0) ||
        BigInt(cost.oldHeldMicroUsd) + BigInt(cost.additionalCapMicroUsd) !== BigInt(cost.worstExposureMicroUsd) ||
        !digest(cost.costReceiptDigest) || !digest(cost.costDigest) ||
        ["catalogApprovalId", "catalogVersion", "pricingVersion"].some(key =>
          typeof cost[key] !== "string" || !cost[key] || String(cost[key]).length > 160)) return null;
  }
  return value as AmuxHostRecoveryRead;
}

/** One mutation at most; a lost answer permits one exact GET, never a POST
 * replay. Both transport and body await end at the same 10-second deadline. */
export async function fetchAmuxHostRecovery({ identity, requestId, action, displayed,
  unknownWrite = false, unknownAction, expectedReceipt,
  controller, isCurrent, fallback, locale = "en", fetcher = adminFetch,
  timeoutMs = AMUX_RECOVERY_INSPECTION_TIMEOUT_MS }: {
  identity: AmuxRecoveryInspectionIdentity; requestId: string;
  action?: RecoveryAction; displayed?: AmuxV22RecoveryRead;
  unknownWrite?: boolean; unknownAction?: RecoveryAction; expectedReceipt?: RecoveryReceiptBinding;
  controller: AbortController; isCurrent: () => boolean; fallback: string;
  locale?: "en" | "ko"; fetcher?: typeof adminFetch; timeoutMs?: number;
}): Promise<AmuxHostRecoveryState | null> {
  if (!isCurrent() || controller.signal.aborted) return null;
  const unresolvedAction = unknownAction ?? action;
  const receiptBinding = expectedReceipt ?? (action === "approve_attempt" && displayed?.cost ? {
    inspectionId: displayed.inspectionId, evidenceId: displayed.evidenceId,
    evidenceDigest: displayed.evidenceDigest, costDigest: displayed.cost.costDigest } : undefined);
  let unresolvedWrite = unknownWrite;
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const abort = () => rejectAborted(new DOMException("Aborted", "AbortError"));
  controller.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const bounded = <T,>(promise: Promise<T>) => Promise.race([promise, aborted]);
  const unavailable = (failure: AdminApiFailure | null, unconfirmed = unresolvedWrite || Boolean(action)) =>
    ({ state: "unavailable", failure, requestId, unknownWrite: unconfirmed,
      ...(unconfirmed ? { unknownAction: unresolvedAction, expectedReceipt: receiptBinding } : {}) }) as AmuxHostRecoveryState;
  const parse = async (response: Response): Promise<AmuxHostRecoveryState | null> => {
    if (!isCurrent()) return null;
    if (response.status === 409) {
      const failure = await bounded(readAdminApiFailure(response, { fallback, locale }));
      if (!isCurrent()) return null;
      const code = /^[A-Za-z0-9_]{1,128}$/.test(failure.message) ? failure.message : null;
      if (unresolvedWrite) return unavailable(failure, true);
      if (code === "recovery_disabled") return unavailable(failure, false);
      return { state: "changed", reason: code };
    }
    if (!response.ok) {
      const failure = await bounded(readAdminApiFailure(response, { fallback, locale }));
      if (!isCurrent()) return null;
      return unavailable(failure, unresolvedWrite || ![400, 403, 404, 413, 428, 429].includes(response.status));
    }
    const data = bindAmuxHostRecovery(await bounded(response.json()), identity, requestId);
    if (!isCurrent()) return null;
    if (!data) return unresolvedWrite || action ? unavailable(null, true) : { state: "changed" };
    if ((unresolvedWrite || action) && (data.state === "not_visible" ||
        (unresolvedAction === "approve_attempt" && data.state !== "approved"))) return unavailable(null, true);
    if (data.state === "approved" && receiptBinding &&
        (data.inspectionId !== receiptBinding.inspectionId || data.evidenceId !== receiptBinding.evidenceId ||
         data.evidenceDigest !== receiptBinding.evidenceDigest || data.cost?.costDigest !== receiptBinding.costDigest))
      return unavailable(null, true);
    return { state: "ready", data };
  };
  const read = () => bounded(fetcher(`/api/admin/amux/execution-recovery?${new URLSearchParams({
    taskId: identity.taskId, requestId })}`, { cache: "no-store", signal: controller.signal, timeoutMs }));
  try {
    if (action && unknownWrite) return unavailable(null, true);
    if (!action) return await parse(await read());
    if (identity.attemptId === null || !uuid(requestId)) return { state: "changed" };
    const body = { action, taskId: identity.taskId, expectedRevision: identity.taskRevision,
      priorAttemptId: identity.attemptId, requestId,
      ...(action === "approve_attempt" ? { inspectionId: displayed?.inspectionId,
        evidenceId: displayed?.evidenceId, evidenceDigest: displayed?.evidenceDigest,
        costDigest: displayed?.cost?.costDigest } : {}) };
    if (action === "approve_attempt" && (!displayed || displayed.state !== "verified" ||
        !bindAmuxHostRecovery(displayed, identity, displayed.requestId))) return { state: "changed" };
    try {
      const response = await bounded(fetcher("/api/admin/amux/execution-recovery", {
        method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: controller.signal, timeoutMs }));
      const result = await parse(response);
      if (result?.state !== "unavailable" || !result.unknownWrite) return result;
    } catch { /* A single exact read below resolves a lost write answer. */ }
    if (!isCurrent()) return null;
    unresolvedWrite = true;
    if (controller.signal.aborted) return unavailable(null);
    return await parse(await read());
  } catch { return isCurrent() ? unavailable(null) : null; }
  finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); }
}

/** On-demand GET only. Each await is fenced against close, replacement and
 * timeout, including a delayed response body. It never retries a write. */
export async function fetchAmuxRecoveryInspection({ identity, taskStatus,
  controller, isCurrent, fallback, locale = "en", fetcher = adminFetch,
  timeoutMs = AMUX_RECOVERY_INSPECTION_TIMEOUT_MS }: {
  identity: AmuxRecoveryInspectionIdentity; taskStatus: string;
  controller: AbortController; isCurrent: () => boolean; fallback: string;
  locale?: "en" | "ko"; fetcher?: typeof adminFetch; timeoutMs?: number;
}): Promise<AmuxRecoveryInspectionState | null> {
  if (!isCurrent() || controller.signal.aborted) return null;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const params = new URLSearchParams({ view: "recovery_inspection", taskId: identity.taskId,
      taskRevision: String(identity.taskRevision) });
    if (identity.attemptId !== null) params.set("attemptId", identity.attemptId);
    const response = await fetcher(`/api/admin/amux/execution-view?${params}`,
      { cache: "no-store", signal: controller.signal, timeoutMs });
    if (!isCurrent()) return null;
    if (controller.signal.aborted) return { state: "unavailable", failure: null };
    if (response.status === 409) {
      await discardResponseBody(response);
      return isCurrent() ? { state: "changed" } : null;
    }
    if (!response.ok) {
      const failure = await readAdminApiFailure(response, { fallback, locale });
      if (!isCurrent()) return null;
      return { state: "unavailable", failure };
    }
    const value: unknown = await response.json();
    if (!isCurrent()) return null;
    if (controller.signal.aborted) return { state: "unavailable", failure: null };
    const inspection = bindAmuxRecoveryInspection(value, identity);
    return inspection && inspection.task.status === taskStatus ? { state: "ready", inspection }
      : { state: "changed" };
  } catch {
    return isCurrent() ? { state: "unavailable", failure: null } : null;
  } finally { clearTimeout(timer); }
}

const amount = (value: string | null, fallback: string) => {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return fallback;
  const microusd = BigInt(value);
  const fraction = (microusd % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `US$${microusd / BigInt(1_000_000)}.${fraction}`;
};

export function AmuxRecoveryInspectionView({ m, state, onInspect, onReloadReview, busy = false,
  date }: { m: Messages; state: AmuxRecoveryInspectionState; onInspect: () => void;
  onReloadReview: () => void; date: (value: string) => string; busy?: boolean }) {
  const data = state.state === "ready" ? state.inspection : null;
  return <section className="mt-4 rounded-xl border border-zinc-700 bg-zinc-950/60 p-4"
    data-testid="admin-amux-recovery-inspection">
    <h6 className="font-bold text-zinc-100">{m.title}</h6>
    <p className="mt-2 text-sm leading-6 text-zinc-300">{m.intro}</p>
    <button type="button" onClick={onInspect} disabled={busy || state.state === "loading" || state.state === "changed"}
      data-testid="admin-amux-inspect-records"
      className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg border border-blue-500/40 px-4 py-2 text-sm font-semibold text-blue-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-60">
      {state.state === "loading" ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
        : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
      {state.state === "ready" || state.state === "unavailable" ? m.inspectAgain : m.inspect}
    </button>
    <div role="status" aria-live="polite" className="mt-3 text-sm leading-6 text-zinc-300">
      {state.state === "idle" && m.noInspection}
      {state.state === "loading" && m.loading}
      {state.state === "unavailable" && !state.failure && m.unavailable}
      {state.state === "changed" && <><p>{m.changed}</p><button type="button" onClick={onReloadReview}
        className="mt-2 min-h-11 rounded-lg border border-amber-300/40 px-4 py-2 font-semibold text-amber-100">{m.reloadReview}</button></>}
      {data && <>
        <p>{m.checkedAt}: <time dateTime={data.checkedAt}>{date(data.checkedAt)}</time></p>
        <dl className="mt-3 space-y-4">
          <div><dt className="font-semibold text-zinc-100">{m.result}</dt>
            <dd>{m.resultState[data.result.state]}</dd></div>
          <div><dt className="font-semibold text-zinc-100">{m.usage}</dt>
            <dd>{m.usageState[data.usage.state]}</dd>
            <dd>{m.receiptCount(data.usage.displayedCount, data.usage.displayLimit)}</dd>
            {data.usage.state === "reported_complete" && <dd>{m.inputTokens}: {data.usage.inputTokens} · {m.outputTokens}: {data.usage.outputTokens}</dd>}
          </div>
          <div><dt className="font-semibold text-zinc-100">{m.reservation}</dt>
            <dd>{amount(data.cost.reservedMaximumMicrousd, m.unknown)}</dd>
            <dt className="mt-2 font-semibold text-zinc-100">{m.settlement}</dt>
            <dd>{data.cost.confirmed ? amount(data.cost.settledMicrousd, m.unknown) : m.unknown}</dd>
            <dd>{data.cost.confirmed ? m.confirmedCost : m.unknownCost}</dd></div>
          <div><dt className="font-semibold text-zinc-100">{m.worker}</dt>
            <dd className="break-words">{data.attempt?.worker ?? m.unknown}</dd>
            <dt className="mt-2 font-semibold text-zinc-100">{m.runtime}</dt>
            <dd>{data.runtime.state === "not_recorded" ? m.runtimeMissing : data.runtime.state === "different_instance"
              ? m.runtimeDifferent : `${data.runtime.status} · ${data.runtime.heartbeatAt ? date(data.runtime.heartbeatAt) : m.unknown}`}</dd>
            <dd>{m.runtimeBoundary}</dd></div>
        </dl>
        <p className="mt-4 font-semibold text-amber-200">{m.hostTitle}</p>
        <p className="mt-1 text-amber-100/90">{m.hostBoundary}</p>
        <p className="mt-3 text-zinc-400">{m.noAction}</p>
      </>}
    </div>
    {state.state === "unavailable" && state.failure && <AdminApiFailureNotice failure={state.failure}
      returnTo="/admin/amux-execution?tab=assignment" />}
  </section>;
}

export function AmuxHostRecoveryView({ m, state, confirmed, onConfirm, onRequest,
  onRefresh, onApprove, onReloadReview, canRequest, busy = false, writesBlocked = false,
  storageBlocked = false }: {
  m: Messages; state: AmuxHostRecoveryState; confirmed: boolean;
  onConfirm: (value: boolean) => void; onRequest: () => void; onRefresh: () => void;
  onApprove: () => void; onReloadReview: () => void; canRequest: boolean; busy?: boolean;
  writesBlocked?: boolean; storageBlocked?: boolean;
}) {
  const data = state.state === "ready" ? state.data : null;
  const canApprove = data?.state === "verified" && data.cost !== null && data.recoveryEnabled !== false;
  const requestId = data?.requestId ?? (state.state === "unavailable" ? state.requestId : null);
  const disabled = data?.recoveryEnabled === false || data?.reason === "recovery_disabled" ||
    (state.state === "unavailable" && state.failure?.message === "recovery_disabled");
  const button = "inline-flex min-h-11 items-center justify-center rounded-lg border border-blue-500/40 px-4 py-2 text-sm font-semibold text-blue-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-60";
  return <section className="mt-4 rounded-xl border border-zinc-700 bg-zinc-950/60 p-4 text-sm leading-6"
    data-testid="admin-amux-host-recovery">
    <h6 className="font-bold text-zinc-100">{m.host.title}</h6>
    <p className="mt-2 text-zinc-300">{m.host.intro}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className={button} onClick={onRequest} data-testid="admin-amux-request-host-inspection"
        disabled={writesBlocked || disabled || busy || !canRequest || state.state === "loading" || state.state === "changed" ||
          (state.state === "unavailable" && state.unknownWrite) || data?.state === "approved"}>
        {requestId ? m.host.requestAgain : m.host.request}</button>
      {requestId && <button type="button" className={button} onClick={onRefresh}
        data-testid="admin-amux-refresh-host-inspection" disabled={busy || state.state === "loading" || state.state === "changed"}>
        {m.host.refresh}</button>}
    </div>
    {!canRequest && <p className="mt-2 text-amber-200">{m.host.noAttempt}</p>}
    {storageBlocked && <p className="mt-2 text-amber-200">{m.host.storageBlocked}</p>}
    <div className="mt-3 text-zinc-300" role="status" aria-live="polite">
      {state.state === "idle" && m.host.idle}
      {state.state === "loading" && <span className="inline-flex items-center gap-2"><Loader2 aria-hidden="true"
        className="h-4 w-4 animate-spin" />{m.host.loading}</span>}
      {state.state === "unavailable" && <><p>{disabled ? m.host.disabled : m.host.unavailable}</p>
        {state.unknownWrite && <p className="mt-2 text-amber-200">{m.host.unknownWrite}</p>}</>}
      {state.state === "changed" && <><p>{m.host.changed}</p><button type="button" className={`${button} mt-2`}
        onClick={onReloadReview}>{m.reloadReview}</button>
        {state.reason && <p className="mt-2 break-words">{m.host.reason}: {state.reason}</p>}</>}
      {data && <><p>{disabled ? m.host.disabled : m.host.statuses[data.state]}</p>
        {data.reason === "evidence_stale" && <p className="mt-2 text-amber-200">{m.host.stale}</p>}
        {data.reason === "legacy_invocation_unbound" && <p className="mt-2 text-amber-200">{m.host.legacy}</p>}
        {data.reason === "terminal_success" && <p className="mt-2 text-amber-200">{m.host.success}</p>}
      </>}
    </div>
    {requestId && <dl className="mt-3 space-y-2 break-words text-zinc-300">
      <div><dt className="font-semibold text-zinc-100">{m.host.requestId}</dt><dd>{requestId}</dd></div>
      {data?.inspectionId && <div><dt className="font-semibold text-zinc-100">{m.host.inspectionId}</dt><dd>{data.inspectionId}</dd></div>}
      {data?.evidenceId && <div><dt className="font-semibold text-zinc-100">{m.host.evidenceId}</dt><dd>{data.evidenceId}</dd></div>}
      {data?.evidenceDigest && <div><dt className="font-semibold text-zinc-100">{m.host.evidenceDigest}</dt><dd>{data.evidenceDigest}</dd></div>}
      {data?.reason && <div><dt className="font-semibold text-zinc-100">{m.host.reason}</dt><dd>{data.reason}</dd></div>}
      {data?.approvalId && <div><dt className="font-semibold text-zinc-100">{m.host.approvedId}</dt><dd>{data.approvalId}</dd></div>}
      {data?.taskRevision !== null && data?.taskRevision !== undefined &&
        <div><dt className="font-semibold text-zinc-100">{data.state === "approved" ? m.host.approvedRevision : m.host.revision}</dt><dd>{data.taskRevision}</dd></div>}
      {data?.state === "approved" && <>
        <div><dt className="font-semibold text-zinc-100">{m.host.currentTask}</dt><dd>{data.currentTask?.status ?? m.unknown}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.currentRevision}</dt><dd>{data.currentTask?.revision ?? m.unknown}</dd></div>
        <p className="text-zinc-400">{m.host.currentBoundary}</p>
      </>}
    </dl>}
    {data?.cost && <>
      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <div><dt className="font-semibold text-zinc-100">{m.host.oldHeld}</dt><dd className="mt-1">{amount(data.cost.oldHeldMicroUsd, m.unknown)}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.additional}</dt><dd className="mt-1">{amount(data.cost.additionalCapMicroUsd, m.unknown)}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.worst}</dt><dd className="mt-1">{amount(data.cost.worstExposureMicroUsd, m.unknown)}</dd></div>
      </dl>
      <p className="mt-3 text-zinc-400">{m.host.costBoundary}</p>
      <dl className="mt-3 space-y-2 break-words text-zinc-300">
        <div><dt className="font-semibold text-zinc-100">{m.host.catalog}</dt><dd>{data.cost.catalogApprovalId} · {data.cost.catalogVersion}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.pricing}</dt><dd>{data.cost.pricingVersion}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.costReceipt}</dt><dd>{data.cost.costReceiptDigest}</dd></div>
        <div><dt className="font-semibold text-zinc-100">{m.host.costDigest}</dt><dd>{data.cost.costDigest}</dd></div>
      </dl>
    </>}
    {canApprove && <div className="mt-4 border-t border-zinc-700 pt-3">
      <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-zinc-100">
        <input type="checkbox" checked={confirmed} disabled={busy || writesBlocked} onChange={event => onConfirm(event.target.checked)}
          data-testid="admin-amux-recovery-cost-confirm" className="mt-1 h-4 w-4 shrink-0 accent-blue-500" />
        <span>{m.host.confirm}</span>
      </label>
      <button type="button" className={`${button} mt-2`} onClick={onApprove} disabled={busy || writesBlocked || !confirmed}
        data-testid="admin-amux-approve-recovery">{m.host.approve}</button>
    </div>}
    {data?.state === "approved" && <button type="button" className={`${button} mt-3`}
      onClick={onReloadReview} data-testid="admin-amux-recovery-history">{m.host.trace}</button>}
    {state.state === "unavailable" && state.failure && <AdminApiFailureNotice failure={state.failure}
      returnTo="/admin/amux-execution?tab=assignment" />}
  </section>;
}

export function AmuxOwnerRecoveryInspectionPanel({ identity, taskStatus, onReloadReview }: {
  identity: AmuxRecoveryInspectionIdentity; taskStatus: string; onReloadReview: () => void;
}) {
  const m = useAdminMessages(adminAmuxRecoveryInspectionMessages);
  const { locale } = useAdminLocale();
  const [state, setState] = useState<AmuxRecoveryInspectionState>({ state: "idle" });
  const [host, setHost] = useState<AmuxHostRecoveryState>({ state: "idle" });
  const [confirmed, setConfirmed] = useState(false);
  const [pendingStorage, setPendingStorage] = useState<AmuxPendingRecoveryLoad | { state: "loading" }>({ state: "loading" });
  const pendingRecovery = useRef<AmuxPendingRecovery | null>(null);
  const requestId = useRef(0);
  const active = useRef<AbortController | null>(null);
  const hostRequestId = useRef<string | null>(null);
  const unresolvedState = (pending: AmuxPendingRecovery, failure: AdminApiFailure | null = null): AmuxHostRecoveryState =>
    ({ state: "unavailable", failure, requestId: pending.requestId, unknownWrite: true,
      unknownAction: pending.action, ...(pending.expectedReceipt ? { expectedReceipt: pending.expectedReceipt } : {}) });
  useEffect(() => {
    let disposed = false;
    const restored = readAmuxPendingRecovery(identity.taskId);
    queueMicrotask(() => {
      if (disposed) return;
      setPendingStorage(restored); setConfirmed(false);
      pendingRecovery.current = restored.state === "pending" ? restored.pending : null;
      hostRequestId.current = restored.state === "pending" ? restored.pending.requestId : null;
      setHost(restored.state === "pending" ? { state: "unavailable", failure: null,
        requestId: restored.pending.requestId, unknownWrite: true, unknownAction: restored.pending.action,
        ...(restored.pending.expectedReceipt ? { expectedReceipt: restored.pending.expectedReceipt } : {}) } : { state: "idle" });
    });
    return () => { disposed = true; requestId.current += 1; active.current?.abort(); active.current = null; };
  }, [identity.taskId, identity.taskRevision, identity.attemptId]);
  const inspect = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const current = ++requestId.current;
    const isCurrent = () => current === requestId.current && active.current === controller;
    setState({ state: "loading" });
    const next = await fetchAmuxRecoveryInspection({ identity, taskStatus, controller, isCurrent,
      fallback: m.unavailable, locale });
    if (!isCurrent()) return;
    if (next) setState(next);
    active.current = null;
  };
  const recover = async (action?: RecoveryAction) => {
    if (active.current) return;
    // Recheck synchronously as well: a click can precede hydration, or another
    // mounted panel can have recorded an unresolved request for this task.
    const stored = readAmuxPendingRecovery(identity.taskId);
    const remembered = pendingRecovery.current?.identity.taskId === identity.taskId ? pendingRecovery.current : null;
    let pending = stored.state === "pending" ? stored.pending : remembered;
    setPendingStorage(stored);
    if (pending) {
      pendingRecovery.current = pending; hostRequestId.current = pending.requestId;
      if (action) { setHost(unresolvedState(pending)); return; }
    } else if (stored.state !== "empty" || identity.attemptId === null) return;
    const displayed = host.state === "ready" ? host.data : undefined;
    if (action === "approve_attempt" && (!displayed || displayed.state !== "verified" ||
        !displayed.cost || !bindAmuxHostRecovery(displayed, identity, displayed.requestId))) return;
    const id = pending?.requestId ?? (action ? crypto.randomUUID() : hostRequestId.current);
    if (!id) return;
    if (action) {
      const proposed: AmuxPendingRecovery = { version: 1,
        identity: { ...identity, attemptId: identity.attemptId! }, requestId: id, action,
        expectedReceipt: action === "approve_attempt" ? { inspectionId: displayed!.inspectionId,
          evidenceId: displayed!.evidenceId, evidenceDigest: displayed!.evidenceDigest,
          costDigest: displayed!.cost!.costDigest } : null };
      const saved = saveAmuxPendingRecovery(proposed);
      setPendingStorage(saved);
      if (saved.state !== "pending") return;
      pending = saved.pending; pendingRecovery.current = pending;
      if (pending.requestId !== id) { hostRequestId.current = pending.requestId; setHost(unresolvedState(pending)); return; }
    }
    hostRequestId.current = id;
    const controller = new AbortController(); active.current = controller;
    const current = ++requestId.current;
    const isCurrent = () => current === requestId.current && active.current === controller;
    setConfirmed(false); setHost({ state: "loading" });
    const next = await fetchAmuxHostRecovery({ identity: pending?.identity ?? identity, requestId: id, action, displayed,
      unknownWrite: Boolean(pending && !action), unknownAction: pending?.action,
      expectedReceipt: pending?.expectedReceipt ?? undefined,
      controller, isCurrent, fallback: m.host.unavailable, locale });
    if (!isCurrent()) return;
    if (pending && next) {
      const confirmedResult = next.state === "ready" && next.data.state !== "not_visible" &&
        (pending.action === "approve_attempt" ? next.data.state === "approved" : next.data.state !== "approved");
      if (confirmedResult && clearAmuxPendingRecovery(pending)) {
        pendingRecovery.current = null; setPendingStorage({ state: "empty" });
        const sameIdentity = pending.identity.taskId === identity.taskId &&
          pending.identity.taskRevision === identity.taskRevision && pending.identity.attemptId === identity.attemptId;
        setHost(sameIdentity ? next : { state: "changed" });
      } else {
        setPendingStorage({ state: "pending", pending });
        setHost(unresolvedState(pending, next.state === "unavailable" ? next.failure : null));
      }
    } else if (next) setHost(next);
    active.current = null;
  };
  const date = (value: string) => new Intl.DateTimeFormat(adminIntlLocale(locale), {
    dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
  const busy = state.state === "loading" || host.state === "loading";
  return <><AmuxRecoveryInspectionView m={m} state={state} busy={busy} onInspect={() => void inspect()}
    onReloadReview={onReloadReview} date={date} />
    <AmuxHostRecoveryView m={m} state={host} busy={busy} confirmed={confirmed} onConfirm={setConfirmed}
      writesBlocked={pendingStorage.state !== "empty"} storageBlocked={pendingStorage.state === "blocked"}
      onRequest={() => void recover("request_inspection")} onRefresh={() => void recover()}
      onApprove={() => { if (confirmed) void recover("approve_attempt"); }}
      onReloadReview={onReloadReview} canRequest={identity.attemptId !== null} /></>;
}
