"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminNetworkFailure, readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminAmuxAutoAdmissionMessages } from "@/lib/adminMessages/amuxAutoAdmission";
import {
  amuxAutoAdmissionCanActivate,
  amuxAutoAdmissionNeedsApproval,
  amuxAutoAdmissionWriteLocked,
  parseAmuxAutoAdmissionControl,
  runAmuxAutoAdmissionChange,
  runAmuxAutoAdmissionRead,
  type AmuxAutoAdmissionControl,
  type AmuxAutoAdmissionIo,
  type AmuxAutoAdmissionNotice,
  type AmuxAutoAdmissionPending,
  type AmuxAutoAdmissionUpdate,
} from "@/lib/amux/autoAdmissionControlCore";

type Messages = (typeof adminAmuxAutoAdmissionMessages)["en"];
const CONTROL_PATH = "/api/admin/amux/v22-auto-promotion";
const buttonClass = "relative inline-flex min-h-11 items-center justify-center rounded-lg border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700";
const helpClass = "text-xs leading-5 text-zinc-600 dark:text-zinc-400";
const chipClass = "inline-flex rounded-md bg-zinc-200 px-2.5 py-1.5 text-xs font-semibold dark:bg-zinc-800";
const positiveClass = "text-status-success-700 dark:text-status-success-300";
const switchOnClass = "text-status-switch-on-700 dark:text-status-switch-on-300";

/** Only returned control fields are state. Claim and execution remain scope text. */
export function AmuxAutoAdmissionControlView({
  m, control, pending, notice, failure, confirmed, onConfirmChange, onConfigure, onRead,
}: {
  m: Messages;
  control: AmuxAutoAdmissionControl | null;
  pending: AmuxAutoAdmissionPending;
  notice: AmuxAutoAdmissionNotice;
  failure: AdminApiFailure | null;
  confirmed: boolean;
  onConfirmChange: (confirmed: boolean) => void;
  onConfigure: (active: boolean) => void;
  onRead: () => void;
}) {
  const locked = amuxAutoAdmissionWriteLocked(notice);
  const busy = pending !== null;
  const approvalNeeded = control !== null && amuxAutoAdmissionNeedsApproval(control);
  const canActivate = control !== null && amuxAutoAdmissionCanActivate(control);
  const serverOpen = control?.codeLatch && control.environmentEnabled;
  const stateChip = control ? control.active ? m.ownerOn : m.ownerOff : m.unreadable;
  const stateSummary = control
    ? control.active ? m.activeSummary : m.inactiveSummary
    : pending === "reading" ? m.loading : m.unknownSummary;
  const graduationState = control ? control.graduation.ok ? m.graduationMet
    : m.graduationUnmet : m.unreadable;
  return (
    <section className="mx-auto w-full min-w-0 max-w-6xl p-4"
      data-testid="amux-v22-promotion-control" aria-busy={busy}>
      <div className="space-y-5 rounded-2xl border border-zinc-300 bg-white p-5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 md:p-7">
        <div className="space-y-2">
          <h2 className="text-[22px] font-semibold leading-snug">{m.title}</h2>
          <p className="leading-6 text-zinc-600 dark:text-zinc-400">{m.description}</p>
        </div>
        <div className="min-h-28 space-y-2 rounded-xl bg-zinc-100 p-4 dark:bg-zinc-800"
          data-testid="amux-auto-admission-owner-state">
          <span className={`inline-flex text-xs font-semibold ${control?.active ? switchOnClass : "text-zinc-600 dark:text-zinc-400"}`}>
            {stateChip}
          </span>
          <p className="text-base font-semibold leading-6" role={pending === "reading" ? "status" : undefined}>
            {stateSummary}
          </p>
          <p className={helpClass}>{m.recheckHelp}</p>
        </div>
        <div>
          <h3 className="mb-2 font-semibold">{m.gates}</h3>
          <dl className="divide-y divide-zinc-200 dark:divide-zinc-700">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-3" data-testid="amux-auto-admission-server-gate">
              <dt className="font-semibold">{m.serverGate}</dt>
              <dd className={`${chipClass} ${serverOpen ? switchOnClass : "text-zinc-600 dark:text-zinc-400"}`}>
                {control ? serverOpen ? m.gateOpen : m.gateClosed : m.unreadable}
              </dd>
              <dd className={`${helpClass} w-full`}>{m.serverHelp}</dd>
              <dd className={`${helpClass} w-full`}>
                {m.codeGate}: {control ? control.codeLatch ? m.gateOpen : m.gateClosed : m.unreadable}
                {" · "}{m.environmentGate}: {control ? control.environmentEnabled ? m.gateOpen : m.gateClosed : m.unreadable}
              </dd>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-3" data-testid="amux-auto-admission-owner-gate">
              <dt className="font-semibold">{m.ownerGate}</dt>
              <dd className={`${chipClass} ${control?.active ? switchOnClass : "text-zinc-600 dark:text-zinc-400"}`}>
                {control ? control.active ? m.enabled : m.disabled : m.unreadable}
              </dd>
              <dd className={`${helpClass} w-full`}>{m.ownerHelp}</dd>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-3" data-testid="amux-auto-admission-graduation-gate">
              <dt className="font-semibold">{m.graduationGate}</dt>
              <dd className={`${chipClass} ${control?.graduation.ok ? positiveClass : "text-zinc-600 dark:text-zinc-400"}`}>
                {graduationState}
              </dd>
              {control?.graduationExceptionAvailable ? (
                <dd className={`${chipClass} text-amber-700 dark:text-amber-300`}
                  data-testid="amux-auto-admission-exception">
                  {control.graduationExceptionApplied ? m.exceptionApplied : m.exceptionAvailable}
                </dd>
              ) : null}
              <dd className={`${helpClass} w-full`} data-testid="amux-auto-admission-measurement">
                {control ? m.graduationMeasurement(control.graduation.count,
                  Math.floor(control.graduation.spanMs / 86_400_000)) : m.unreadable}
              </dd>
              {control?.graduationExceptionAvailable ? <dd className={`${helpClass} w-full`}>{m.exceptionHelp}</dd> : null}
            </div>
          </dl>
        </div>
        <div className="space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
          <p className="text-[13px] font-semibold leading-6">{m.flow}</p>
          <p className={helpClass}>{m.scopeHelp}</p>
        </div>
        <div className="space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-700">
          {approvalNeeded ? (
            <div className="space-y-2">
              <label className="flex min-h-11 items-start gap-3 py-2 leading-6"
                htmlFor="amux-auto-admission-confirmation">
                <input type="checkbox" id="amux-auto-admission-confirmation"
                  data-testid="amux-auto-admission-confirmation" checked={confirmed}
                  disabled={busy || locked} aria-describedby="amux-auto-admission-confirmation-help"
                  onChange={(event) => onConfirmChange(event.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 accent-blue-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 enabled:cursor-pointer disabled:cursor-not-allowed" />
                <span className="min-w-0 break-words">
                  {control.graduationExceptionAvailable ? m.confirmException : m.confirmPromotion}
                </span>
              </label>
              <p id="amux-auto-admission-confirmation-help" className={helpClass}>{m.confirmationHelp}</p>
              {!canActivate ? <p className={helpClass}>{m.activationBlocked}</p> : null}
            </div>
          ) : null}
          <div className="flex flex-col flex-wrap gap-3 sm:flex-row">
            {approvalNeeded ? (
              <button type="button" className={buttonClass} data-testid="amux-auto-admission-activate"
                disabled={busy || locked || !confirmed || !canActivate}
                onClick={() => onConfigure(true)}>
                <span className={pending === "activating" ? "invisible" : undefined}>{m.activate}</span>
                {pending === "activating" ? <span className="absolute inset-0 flex items-center justify-center">{m.saving}</span> : null}
              </button>
            ) : null}
            {control?.active ? (
              <button type="button" className={buttonClass} data-testid="amux-auto-admission-stop"
                disabled={busy || locked} onClick={() => onConfigure(false)}>
                <span className={pending === "stopping" ? "invisible" : undefined}>{m.stop}</span>
                {pending === "stopping" ? <span className="absolute inset-0 flex items-center justify-center">{m.saving}</span> : null}
              </button>
            ) : null}
            <button type="button" className={buttonClass} data-testid="amux-auto-admission-reread"
              disabled={busy} onClick={onRead}>
              <span className={pending === "reading" ? "invisible" : undefined}>{m.reread}</span>
              {pending === "reading" ? <span className="absolute inset-0 flex items-center justify-center">{m.reading}</span> : null}
            </button>
          </div>
          {control?.active ? <p className={helpClass}>{m.stopHelp}</p> : null}
          {(notice === "saved" && pending !== "reading") || notice === "saved_unread" ? (
            <p role="status" className="text-sm leading-6" data-testid="amux-auto-admission-saved">
              {notice === "saved" ? m.saved : m.savedUnread}
            </p>
          ) : null}
          {notice === "conflict" ? (
            <p role="alert" className="text-sm leading-6 text-amber-700 dark:text-amber-300"
              data-testid="amux-auto-admission-conflict">{m.conflict}</p>
          ) : null}
          {locked ? (
            <p role="alert" className="text-sm leading-6 text-amber-700 dark:text-amber-300"
              data-testid="amux-auto-admission-outcome-unknown">{m.unknownOutcome}</p>
          ) : null}
          {notice === "load_failed" && !failure ? <p role="alert">{m.readFailed}</p> : null}
          {failure ? <AdminApiFailureNotice failure={failure} /> : null}
        </div>
      </div>
      <p className={`${helpClass} mt-4`}>{m.safeReadHelp}</p>
    </section>
  );
}

/** Owner control in Operations settings; routes retain all authorization gates. */
export function AmuxV22PromotionControl() {
  const m = useAdminMessages(adminAmuxAutoAdmissionMessages);
  const { locale } = useAdminLocale();
  const [control, setControl] = useState<AmuxAutoAdmissionControl | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<AmuxAutoAdmissionPending>("reading");
  const [notice, setNotice] = useState<AmuxAutoAdmissionNotice>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const postInFlight = useRef(false);
  const readInFlight = useRef(false);
  const readGeneration = useRef(0);
  const deferredLocaleRead = useRef<AmuxAutoAdmissionIo | null>(null);
  const mounted = useRef(false);
  const unknownWrite = useRef(false);
  const currentNotice = useRef<AmuxAutoAdmissionNotice>(null);
  const apply = useCallback((change: AmuxAutoAdmissionUpdate) => {
    if (!mounted.current) return;
    if ("control" in change) setControl(change.control ?? null);
    if ("notice" in change) {
      setNotice(change.notice ?? null);
      currentNotice.current = change.notice ?? null;
      if (amuxAutoAdmissionWriteLocked(change.notice ?? null)) unknownWrite.current = true;
    }
    if ("pending" in change) setPending(change.pending ?? null);
    if ("failure" in change) setFailure(change.failure ?? null);
    if ("confirmed" in change) setConfirmed(change.confirmed ?? false);
  }, []);
  const io = useMemo<AmuxAutoAdmissionIo>(() => ({
    post: (body) => adminFetch(CONTROL_PATH, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    read: async () => {
      try {
        const response = await adminFetch(CONTROL_PATH, { method: "GET", cache: "no-store" });
        if (!response.ok) return { control: null,
          failure: await readAdminApiFailure(response, { fallback: m.readFailed, locale }) };
        const value = parseAmuxAutoAdmissionControl(await response.json().catch(() => null));
        return value ? { control: value, failure: null }
          : { control: null, failure: { ...adminNetworkFailure(locale), message: m.readFailed } };
      } catch { return { control: null, failure: adminNetworkFailure(locale) }; }
    },
    failureOf: (response) => readAdminApiFailure(response, { fallback: m.changeFailed, locale }),
    networkFailure: () => adminNetworkFailure(locale),
  }), [locale, m.readFailed, m.changeFailed]);
  const read = useCallback(async (readIo: AmuxAutoAdmissionIo) => {
    const generation = ++readGeneration.current;
    readInFlight.current = true;
    try {
      await runAmuxAutoAdmissionRead(readIo, (change) => {
        if (generation === readGeneration.current) apply(change);
      }, unknownWrite.current ? "outcome_unknown" : currentNotice.current);
    } finally {
      // A superseded GET cannot release the lock held by its replacement.
      if (generation === readGeneration.current) readInFlight.current = false;
    }
  }, [apply]);
  useEffect(() => {
    mounted.current = true;
    // A locale change must not overlap a POST or its acknowledged read-back.
    if (postInFlight.current) deferredLocaleRead.current = io;
    else void read(io);
    return () => {
      mounted.current = false;
      // StrictMode's next setup starts a fresh GET; older responses stay fenced.
      readGeneration.current += 1;
    };
  }, [io, read]);
  const reread = async () => {
    if (!mounted.current || postInFlight.current || readInFlight.current) return;
    await read(io);
  };
  const configure = async (active: boolean) => {
    if (!mounted.current || postInFlight.current || readInFlight.current || unknownWrite.current) return;
    postInFlight.current = true;
    try { await runAmuxAutoAdmissionChange({ active, control, confirmed, notice, pending }, io, apply); }
    finally {
      postInFlight.current = false;
      const nextIo = deferredLocaleRead.current;
      deferredLocaleRead.current = null;
      // The latest locale read starts only once the whole POST sequence ends.
      if (nextIo && mounted.current) await read(nextIo);
    }
  };
  return <AmuxAutoAdmissionControlView m={m} control={control} confirmed={confirmed}
    pending={pending} notice={notice} failure={failure} onConfirmChange={setConfirmed}
    onConfigure={(active) => void configure(active)} onRead={() => void reread()} />;
}
