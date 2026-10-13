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

export const AMUX_RECOVERY_INSPECTION_TIMEOUT_MS = 10_000;
type Messages = AdminMessageShape<(typeof adminAmuxRecoveryInspectionMessages)["en"]>;
export type AmuxRecoveryInspectionState =
  | { state: "idle" | "loading" | "changed" }
  | { state: "unavailable"; failure: AdminApiFailure | null }
  | { state: "ready"; inspection: AmuxOwnerRecoveryInspection };

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
  const fraction = (microusd % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/, "");
  return `US$${microusd / BigInt(1_000_000)}${fraction ? `.${fraction}` : ""}`;
};

export function AmuxRecoveryInspectionView({ m, state, onInspect, onReloadReview,
  date }: { m: Messages; state: AmuxRecoveryInspectionState; onInspect: () => void;
  onReloadReview: () => void; date: (value: string) => string }) {
  const data = state.state === "ready" ? state.inspection : null;
  return <section className="mt-4 rounded-xl border border-zinc-700 bg-zinc-950/60 p-4"
    data-testid="admin-amux-recovery-inspection">
    <h6 className="font-bold text-zinc-100">{m.title}</h6>
    <p className="mt-2 text-sm leading-6 text-zinc-300">{m.intro}</p>
    <button type="button" onClick={onInspect} disabled={state.state === "loading" || state.state === "changed"}
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

export function AmuxOwnerRecoveryInspectionPanel({ identity, taskStatus, onReloadReview }: {
  identity: AmuxRecoveryInspectionIdentity; taskStatus: string; onReloadReview: () => void;
}) {
  const m = useAdminMessages(adminAmuxRecoveryInspectionMessages);
  const locale = useAdminLocale();
  const [state, setState] = useState<AmuxRecoveryInspectionState>({ state: "idle" });
  const requestId = useRef(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { requestId.current += 1; active.current?.abort(); active.current = null; }, []);
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
  const date = (value: string) => new Intl.DateTimeFormat(adminIntlLocale(locale), {
    dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
  return <AmuxRecoveryInspectionView m={m} state={state} onInspect={() => void inspect()}
    onReloadReview={onReloadReview} date={date} />;
}
