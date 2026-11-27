import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Language } from "../../../../lib/language";
import { desktopManagedCodeCopy, type DesktopManagedCodeCopy } from "../../../../locales/desktopManagedCode";
import { describeExecutionLocations, type ExecutionLocationId } from "../execution-location";
import { MANAGED_MAX_APPROVED_CREDITS, type DesktopManagedCodeInput, type ManagedCodeView, type ManagedReservationView } from "../managed-code-contract";
import { CodeCloudTasks } from "./CodeCloudTasks";
import "./code-cloud.css";

type Copy = DesktopManagedCodeCopy;
const POLL_MS = 5_000;

const locationText = (copy: Copy, cloudOn: boolean): Record<ExecutionLocationId, [string, string]> => ({
  local: [copy.locLocal, copy.locLocalDetail], worktree: [copy.locWorktree, copy.locWorktreeDetail],
  ssh: [copy.locSsh, copy.locSshDetail], cloud: [copy.locCloud, cloudOn ? copy.locCloudOnDetail : copy.locCloudDetail],
});

function endedText(copy: Copy, reservation: ManagedReservationView) {
  if (reservation.state === "outcome_unknown") return copy.endedUnknown;
  if (reservation.state === "interrupted") return copy.endedInterrupted;
  if (reservation.endedBy === "completed") return copy.endedCompleted;
  if (reservation.endedBy === "cancelled") return copy.endedCancelled;
  return copy.endedOther;
}

function Reservation({ copy, reservation, busy, run }: {
  copy: Copy; reservation: ManagedReservationView; busy: boolean; run: (input: DesktopManagedCodeInput) => void;
}) {
  const { billing } = reservation;
  const active = reservation.state === "active";
  const stateLabel = { active: copy.stateActive, interrupted: copy.stateInterrupted, closed: copy.stateClosed,
    outcome_unknown: copy.stateUnknown, other: copy.stateOther }[reservation.state];
  const rows: Array<[string, string, number]> = [
    ["reserved", copy.reserved, billing.reservedCredits], ["held", copy.held, billing.heldCredits],
    ["available", copy.available, billing.availableCredits], ["settled", copy.settled, billing.settledCredits],
    ["returned", copy.returned, billing.releasedCredits],
    ...(billing.unknownHeldCredits ? [["unknown", copy.unknownHeld, billing.unknownHeldCredits] as [string, string, number]] : []),
  ];
  return <div className="managed-reservation" data-testid="managed-reservation" data-state={reservation.state}>
    <h4>{copy.reservationHeading}: <span data-testid="managed-state">{stateLabel}</span></h4>
    <p>{reservation.executor.name} / {reservation.reviewer.name}</p>
    <dl>{rows.map(([key, label, value]) => <div key={key} data-testid={`managed-credits-${key}`}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {active && reservation.heartbeat === "lost" && <p role="status" data-testid="managed-heartbeat-lost">{copy.heartbeatLost}</p>}
    {active
      ? <button className="soft" type="button" disabled={busy}
        onClick={() => run({ action: "release", reason: billing.settledCredits > 0 ? "completed" : "cancelled" })}>{copy.release}</button>
      : <>
        <p role="status" data-testid="managed-ended">{endedText(copy, reservation)}</p>
        <button className="soft" type="button" disabled={busy} onClick={() => run({ action: "dismiss" })}>{copy.dismiss}</button>
      </>}
  </div>;
}

function ReserveForm({ copy, view, busy, run }: {
  copy: Copy; view: ManagedCodeView; busy: boolean; run: (input: DesktopManagedCodeInput) => void;
}) {
  const models = view.catalog?.models ?? [];
  const [executorId, setExecutorId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [amount, setAmount] = useState("");
  const [confirming, setConfirming] = useState(false);
  const executor = models.find((model) => model.id === executorId);
  const reviewer = models.find((model) => model.id === reviewerId);
  const credits = /^\d{1,7}$/.test(amount) ? Number(amount) : 0;
  const samePlace = !!executor && !!reviewer && executor.provider === reviewer.provider;
  const ready = !!executor && !!reviewer && !samePlace && credits > 0 && credits <= MANAGED_MAX_APPROVED_CREDITS;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ready) setConfirming(true);
  }
  const options = <>
    <option value="">{copy.chooseModel}</option>
    {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
  </>;
  if (!view.catalog) return <p role="status">{copy.readingModels}</p>;
  if (!models.length) return <p>{copy.noModels}</p>;
  return <form className="managed-form" onSubmit={submit} data-testid="managed-form">
    <div><label htmlFor="managed-executor">{copy.executor}</label>
      <select id="managed-executor" value={executorId} disabled={busy || confirming}
        onChange={(event) => { setExecutorId(event.currentTarget.value); setConfirming(false); }}>{options}</select></div>
    <div><label htmlFor="managed-reviewer">{copy.reviewer}</label>
      <select id="managed-reviewer" value={reviewerId} disabled={busy || confirming}
        onChange={(event) => { setReviewerId(event.currentTarget.value); setConfirming(false); }}>{options}</select></div>
    {samePlace && <small role="status">{copy.providersDiffer}</small>}
    <div><label htmlFor="managed-credits">{copy.credits}</label>
      <input id="managed-credits" type="text" inputMode="numeric" maxLength={7} value={amount} disabled={busy || confirming}
        aria-invalid={amount !== "" && credits === 0} onChange={(event) => { setAmount(event.currentTarget.value); setConfirming(false); }} /></div>
    {!confirming && <button className="soft" type="submit" disabled={busy || !ready}>{copy.review}</button>}
    {confirming && executor && reviewer && <div className="managed-confirm" data-testid="managed-confirm" role="group" aria-label={copy.review}>
      <p>{copy.confirmText.replace("{credits}", () => String(credits)).replace("{executor}", () => executor.name).replace("{reviewer}", () => reviewer.name)}</p>
      <div className="managed-actions">
        <button className="soft" type="button" disabled={busy} data-testid="managed-confirm-reserve" onClick={() => {
          setConfirming(false);
          run({ action: "reserve", executorModelId: executor.id, reviewerModelId: reviewer.id, approvedCredits: credits });
        }}>{copy.confirm.replace("{credits}", () => String(credits))}</button>
        <button className="soft" type="button" disabled={busy} onClick={() => setConfirming(false)}>{copy.cancel}</button>
      </div>
    </div>}
  </form>;
}

function CloudSection({ language, remoteEnabled, managedEnabled, cloudEnabled }: { language: Language; remoteEnabled: boolean; managedEnabled: boolean; cloudEnabled: boolean }) {
  const copy = desktopManagedCodeCopy[language];
  // The SSH row follows the remote-projects switch of this computer; the cloud row follows the server's capability.
  const locations = describeExecutionLocations({ ...(remoteEnabled ? { ssh: { available: true } } : {}), cloud: cloudEnabled });
  const [view, setView] = useState<ManagedCodeView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = useCallback((input: DesktopManagedCodeInput) => {
    setBusy(true);
    window.desktop.managedCode(input).then((next) => { setView(next); setFailed(false); }, () => setFailed(true)).finally(() => setBusy(false));
  }, []);
  useEffect(() => {
    if (!managedEnabled) return undefined;
    let current = true;
    window.desktop.managedCode({ action: "read" }).then((next) => { if (current) setView(next); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [managedEnabled]);
  // The main process keeps the reservation alive; this only re-reads what its receipts say.
  const active = view?.reservation?.state === "active";
  useEffect(() => {
    if (!active) return undefined;
    let current = true;
    const handle = setInterval(() => {
      window.desktop.managedCode({ action: "read" }).then((next) => { if (current) setView(next); }, () => {});
    }, POLL_MS);
    return () => { current = false; clearInterval(handle); };
  }, [active]);

  const names = locationText(copy, cloudEnabled);
  return <section className="managed-code" aria-labelledby="managed-code-heading" data-testid="managed-code">
    <h3 id="managed-code-heading">{copy.heading}</h3>
    <h4>{copy.locationsHeading}</h4>
    <ul className="managed-locations" data-testid="execution-locations">
      {locations.map((location) => <li key={location.id} data-testid={`execution-location-${location.id}`} data-available={String(location.available)}>
        <div><strong>{names[location.id][0]}</strong><small>{names[location.id][1]}</small></div>
        <span>{location.available ? copy.availableLabel : copy.unavailableLabel}</span>
      </li>)}
    </ul>
    {cloudEnabled && <CodeCloudTasks language={language} />}
    {managedEnabled && <>
      <h4>{copy.creditsHeading}</h4>
      <p>{copy.creditsIntro}</p>
      <p data-testid="managed-no-runner">{copy.noRunner}</p>
      {view?.reservation
        ? <Reservation copy={copy} reservation={view.reservation} busy={busy} run={run} />
        : view ? <ReserveForm copy={copy} view={view} busy={busy} run={run} /> : null}
      {view?.refusal && <p role="alert" data-testid="managed-refusal" data-reason={view.refusal}>{copy.refusal[view.refusal]}</p>}
      {failed && <p role="alert" data-testid="managed-failed">{copy.refusal.unavailable}</p>}
    </>}
  </section>;
}

/** Desktop > Execution and limits > Cloud and managed credits. Nothing renders unless one of the server's two capabilities is on. */
export function CodeCloudSettings({ language, enabled, remoteEnabled = false, cloudEnabled = false }: {
  language: Language; enabled: boolean; remoteEnabled?: boolean; cloudEnabled?: boolean;
}) {
  return enabled || cloudEnabled ? <CloudSection language={language} remoteEnabled={remoteEnabled} managedEnabled={enabled} cloudEnabled={cloudEnabled} /> : null;
}
