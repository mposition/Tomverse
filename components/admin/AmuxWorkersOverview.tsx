"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import {
  AmuxCliModelIssueChips,
  AmuxWorkerCapabilityEditor,
  runAmuxWorkerCapabilityEdit,
  type AmuxWorkerCapabilityIo,
  type AmuxWorkerCapabilityNotice,
  type AmuxWorkerCapabilityRefusalNotice,
  type AmuxWorkerCapabilityUpdate,
} from "@/components/admin/AmuxWorkerCapabilityPanel";
import {
  runAmuxWorkerRegistration,
  runAmuxWorkerRegistryReread,
  runAmuxWorkerSeedRegistration,
  runAmuxWorkerStateChange,
  type AmuxWorkerRegistrationRequest,
  type AmuxWorkerRegistryIo,
  type AmuxWorkerRegistryNotice,
  type AmuxWorkerRegistryPending,
  type AmuxWorkerRegistryRefusal,
  type AmuxWorkerRegistryUpdate,
} from "@/components/admin/amuxWorkerRegistryRun";
import type { AgentOfficeAmuxState, AgentOfficeAmuxWorkerState } from "@/lib/agentOffice/live";
import {
  adminNetworkFailure,
  readAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxWorkerCapabilityMessages } from "@/lib/adminMessages/amuxWorkerCapability";
import { adminAmuxWorkersMessages } from "@/lib/adminMessages/amuxWorkers";
import type { AmuxCliModelCatalogAdminView } from "@/lib/amux/cliModelCatalogCore";
import {
  parseAmuxWorkerCapabilityAdminView,
  type AmuxWorkerCapabilityAdminRow,
  type AmuxWorkerCapabilityAdminView,
} from "@/lib/amux/workerCapabilityCore";
import {
  amuxWorkerCapabilityFormFromRow,
  type AmuxWorkerCapabilityForm,
} from "@/lib/amux/workerCapabilityEditCore";
import {
  AMUX_WORKER_ACTION_TARGET,
  AMUX_WORKER_OVERVIEW_FILTERS,
  amuxWorkerBridgeUnit,
  amuxWorkerEnableCommand,
  amuxWorkerFilterCount,
  buildAmuxWorkerOverview,
  filterAmuxWorkerRows,
  groupAmuxWorkerRows,
  type AmuxWorkerOverview,
  type AmuxWorkerOverviewAction,
  type AmuxWorkerOverviewFilter,
  type AmuxWorkerOverviewRow,
  type AmuxWorkerProviderCount,
  type AmuxWorkerStatusTone,
} from "@/lib/amux/workerOverviewCore";
import {
  AMUX_WORKER_PROVIDER_CLASSES,
  AMUX_WORKER_ROLE_CEILINGS,
  amuxWorkerRoleWithinClass,
  amuxWorkerSeedEntriesToRegister,
  isAmuxWorkerName,
  parseAmuxWorkerRegistryAdminView,
  type AmuxWorkerProviderClass,
  type AmuxWorkerRoleCeiling,
  type AmuxWorkerRegistryAdminView,
  type AmuxWorkerSeedEntry,
} from "@/lib/amux/workerRegistryCore";

const REGISTRY_PATH = "/api/admin/amux/workers";
const AMUX_WORKER_CAPABILITY_PATH = "/api/admin/amux/workers/capabilities";

type Messages = (typeof adminAmuxWorkersMessages)["en"];
type CapabilityMessages = (typeof adminAmuxWorkerCapabilityMessages)["en"];

const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-md border px-3 py-1 text-sm font-semibold disabled:opacity-60 border-zinc-500 text-zinc-100 hover:bg-zinc-800";
const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-blue-600 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60";
const chipClass = "inline-flex items-center rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-200";

const TONE_PILL: Readonly<Record<AmuxWorkerStatusTone, string>> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  attention: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  neutral: "border-zinc-600 bg-zinc-800 text-zinc-300",
};
const TONE_DOT: Readonly<Record<AmuxWorkerStatusTone, string>> = {
  ok: "bg-emerald-400",
  attention: "bg-amber-400",
  neutral: "bg-zinc-400",
};

const brisbaneTime = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Brisbane",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** "12 s ago" in the console's language; null when the bridge never signalled. */
export function amuxWorkerAgeText(m: Messages, seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return m.age.seconds(seconds);
  if (seconds < 3600) return m.age.minutes(Math.floor(seconds / 60));
  if (seconds < 86_400) return m.age.hours(Math.floor(seconds / 3600));
  return m.age.days(Math.floor(seconds / 86_400));
}

/** The one sentence under a worker's status: what is true and what to do about it. */
export function amuxWorkerReasonText(m: Messages, row: Pick<AmuxWorkerOverviewRow, "status" | "heartbeatAgeSeconds">): string {
  const reason = m.reason[row.status] as (age: string | null) => string;
  return reason(amuxWorkerAgeText(m, row.heartbeatAgeSeconds));
}

const providerCounts = (counts: readonly AmuxWorkerProviderCount[]) =>
  counts.map((entry) => `${entry.providerClass} ${entry.count}`).join(" · ");

const actionLabel = (m: Messages, action: AmuxWorkerOverviewAction) => m.actions[action];
const actionAriaLabel = (m: Messages, action: AmuxWorkerOverviewAction, worker: string) =>
  m.actions[`${action}Label` as const](worker);

const refusalSentence = (m: Messages, code: string) =>
  (m.change.refusal as Record<string, string>)[code] ?? m.change.failed;

/**
 * The owner names a new worker and chooses the CLI it runs (owner decision
 * 2026-10-27: the name no longer carries the CLI) and its role ceiling. It
 * starts waiting to be turned on. Only what the route would accept is sent.
 */
export function AmuxWorkerRegisterForm({
  m,
  busy,
  taken,
  onRegister,
}: {
  m: Messages;
  busy: boolean;
  /** Names already registered (a retired name is not reused). */
  taken: ReadonlySet<string>;
  onRegister: (request: AmuxWorkerRegistrationRequest) => void;
}) {
  const [workerName, setWorkerName] = useState("");
  const [providerClass, setProviderClass] = useState<AmuxWorkerProviderClass>("codex");
  const [roleCeiling, setRoleCeiling] = useState<AmuxWorkerRoleCeiling>("implementation");
  const ceilings = AMUX_WORKER_ROLE_CEILINGS.filter((ceiling) => amuxWorkerRoleWithinClass(providerClass, ceiling));
  const ceiling = ceilings.includes(roleCeiling) ? roleCeiling : ceilings[ceilings.length - 1]!;
  const name = workerName.trim();
  const problem = name.length === 0 ? null : !isAmuxWorkerName(name) ? m.register.nameInvalid
    : taken.has(name) ? m.register.nameTaken : null;
  const inputClass = "min-h-11 w-full rounded-md border border-zinc-600 bg-zinc-900 px-3 text-base text-zinc-100";
  return (
    <details className="rounded-xl border border-zinc-700 p-4" data-testid="amux-workers-register">
      <summary className="min-h-11 cursor-pointer text-sm font-semibold text-zinc-100">{m.register.title}</summary>
      <form
        className="mt-3 grid gap-3 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && name.length > 0 && problem === null) onRegister({ workerName: name, providerClass, roleCeiling: ceiling });
        }}
      >
        <p className="text-sm text-zinc-300 sm:col-span-3">{m.register.help}</p>
        <label className="flex flex-col gap-1 text-sm text-zinc-200">
          {m.register.name}
          <input
            className={inputClass}
            value={workerName}
            maxLength={40}
            autoComplete="off"
            onChange={(event) => setWorkerName(event.target.value.toLowerCase())}
            data-testid="amux-workers-register-name"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-zinc-200">
          {m.register.cli}
          <select
            className={inputClass}
            value={providerClass}
            onChange={(event) => setProviderClass(event.target.value as AmuxWorkerProviderClass)}
            data-testid="amux-workers-register-cli"
          >
            {AMUX_WORKER_PROVIDER_CLASSES.map((cli) => <option key={cli} value={cli}>{m.register.cliName[cli]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-zinc-200">
          {m.register.ceiling}
          <select
            className={inputClass}
            value={ceiling}
            onChange={(event) => setRoleCeiling(event.target.value as AmuxWorkerRoleCeiling)}
            data-testid="amux-workers-register-ceiling"
          >
            {ceilings.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        </label>
        {problem === null ? null : (
          <p role="alert" className="text-sm text-red-300 sm:col-span-3" data-testid="amux-workers-register-problem">{problem}</p>
        )}
        <button
          type="submit"
          className={`${buttonClass} w-fit`}
          disabled={busy || name.length === 0 || problem !== null}
          data-testid="amux-workers-register-submit"
        >
          {m.register.submit}
        </button>
      </form>
    </details>
  );
}

/**
 * AMUX › Operations settings › Workers, without hooks, so a test can call it
 * and read the tree it returns. It shows what the overview says and offers
 * what the viewer may do; whether a change succeeds is the route's decision
 * (owner role, the stage latch, a recent step-up) and the change rule's.
 */
export function AmuxWorkersOverviewView({
  m,
  cm,
  overview,
  isOwner,
  writesLatch,
  filter,
  query,
  openWorker,
  pending,
  notice,
  lastRun,
  changeWorker,
  refusal,
  failure,
  seedEntries,
  editing,
  capabilityBusy,
  capabilityNotice,
  capabilityRefusal,
  capabilityFailure,
  copied,
  onFilter,
  onQuery,
  onOpen,
  onAction,
  onSeed,
  onReread,
  onEditStart,
  onEditChange,
  onEditCancel,
  onEditSave,
  onCopy,
  cliModels,
  onFix,
  onRegister,
}: {
  m: Messages;
  cm: CapabilityMessages;
  overview: AmuxWorkerOverview | null;
  isOwner: boolean;
  writesLatch: boolean;
  filter: AmuxWorkerOverviewFilter;
  query: string;
  openWorker: string | null;
  pending: AmuxWorkerRegistryPending;
  notice: AmuxWorkerRegistryNotice;
  lastRun: "seed" | "change" | null;
  /** The worker the last single change was for. */
  changeWorker: string | null;
  refusal: AmuxWorkerRegistryRefusal;
  failure: AdminApiFailure | null;
  /** What the first-registration run would still register; null when it is not offered. */
  seedEntries: AmuxWorkerSeedEntry[] | null;
  editing: AmuxWorkerCapabilityForm | null;
  capabilityBusy: boolean;
  capabilityNotice: AmuxWorkerCapabilityNotice;
  capabilityRefusal: AmuxWorkerCapabilityRefusalNotice;
  capabilityFailure: AdminApiFailure | null;
  copied: boolean;
  onFilter: (filter: AmuxWorkerOverviewFilter) => void;
  onQuery: (query: string) => void;
  onOpen: (workerName: string | null) => void;
  onAction: (row: AmuxWorkerOverviewRow, action: AmuxWorkerOverviewAction) => void;
  onSeed: (entries: AmuxWorkerSeedEntry[]) => void;
  onReread: () => void;
  onEditStart: (row: AmuxWorkerCapabilityAdminRow) => void;
  onEditChange: (form: AmuxWorkerCapabilityForm) => void;
  onEditCancel: () => void;
  onEditSave: (form: AmuxWorkerCapabilityForm) => void;
  onCopy: (command: string) => void;
  /** Each CLI's model names, for the editor's choices and the rows' chips; null when unread. */
  cliModels?: AmuxCliModelCatalogAdminView | null;
  /** Opens a worker's details with its editor, from a model chip. */
  onFix?: (row: AmuxWorkerOverviewRow) => void;
  /** Registers a new worker the owner named, with the CLI it runs. */
  onRegister?: (request: AmuxWorkerRegistrationRequest) => void;
}) {
  const busy = pending !== null;
  const canChange = isOwner && writesLatch;
  const models = cliModels ?? null;
  // The model a worker runs: its one-shot model when it takes Tasks.
  const usedModel = (row: AmuxWorkerOverviewRow) => row.capability?.current?.capability.v22?.model ?? row.model;
  const fixable = (row: AmuxWorkerOverviewRow) =>
    canChange && overview !== null && overview.capabilitiesReadable && row.capability !== null && onFix !== undefined;

  if (overview === null) {
    return (
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4" data-testid="amux-workers-overview">
        <h2 className="text-lg font-semibold text-zinc-100">{m.title}</h2>
        <p role="alert" className="text-sm text-red-300" data-testid="amux-workers-unavailable">{m.unavailable}</p>
        <button type="button" className={`${buttonClass} w-fit`} disabled={busy} onClick={onReread} data-testid="amux-workers-reread">
          {pending === "reading" ? m.reading : m.reread}
        </button>
        {failure ? <AdminApiFailureNotice failure={failure} /> : null}
      </section>
    );
  }

  const rows = overview.rows;
  const shown = filterAmuxWorkerRows(rows, filter, query);
  const groups = groupAmuxWorkerRows(shown);
  const openRow = openWorker === null ? null : rows.find((row) => row.workerName === openWorker) ?? null;
  const { summary } = overview;

  const changeButtons = (row: AmuxWorkerOverviewRow) =>
    canChange
      ? row.actions.map((action) => (
          <button
            key={action}
            type="button"
            className={action === "pause" ? buttonClass : primaryButtonClass}
            disabled={busy}
            aria-label={actionAriaLabel(m, action, row.workerName)}
            onClick={() => onAction(row, action)}
            data-testid={`amux-worker-${action}-${row.workerName}`}
          >
            {pending !== null && pending !== "reading" && lastRun === "change" && row.workerName === changeWorker ? m.actions.working : actionLabel(m, action)}
          </button>
        ))
      : [];

  const card = (group: "assignable" | "attention" | "waiting", title: string, count: number, detail: string, tone: AmuxWorkerStatusTone) => (
    <button
      key={group}
      type="button"
      aria-pressed={filter === group}
      aria-label={`${title}: ${count}. ${m.summary.showThese}`}
      onClick={() => onFilter(filter === group ? "all" : group)}
      className={`flex min-h-11 flex-col gap-1 rounded-xl border p-4 text-left ${
        filter === group ? "border-blue-500" : tone === "attention" && count > 0 ? "border-amber-500/60" : "border-zinc-700"
      } bg-zinc-900/60 hover:bg-zinc-800/60`}
      data-testid={`amux-workers-card-${group}`}
    >
      <span className="flex items-center gap-2 text-sm text-zinc-200">
        <span aria-hidden="true" className={`h-2 w-2 rounded-full ${TONE_DOT[count === 0 && tone === "attention" ? "neutral" : tone]}`} />
        {title}
      </span>
      <span className="text-3xl font-bold text-zinc-100" data-testid={`amux-workers-card-${group}-count`}>{count}</span>
      <span className="text-xs text-zinc-400">{detail}</span>
    </button>
  );

  const sampleRow = summary.attention.sample === null ? null : rows.find((row) => row.workerName === summary.attention.sample!.workerName) ?? null;
  const assignableDetail = summary.assignable.count === 0
    ? m.summary.assignableHint
    : `${providerCounts(summary.assignable.byProvider)} — ${m.summary.assignableHint}`;
  const attentionDetail = sampleRow === null
    ? m.summary.attentionNone
    : `${sampleRow.workerName} — ${m.status[sampleRow.status]}`;
  const waitingDetail = summary.waiting.count === 0
    ? m.summary.waitingHint
    : `${providerCounts(summary.waiting.byProvider)} — ${m.summary.waitingHint}`;

  const runNotice = (() => {
    if (notice === null) return null;
    if (notice === "done" && lastRun === "change") {
      return (
        <p role="status" className="text-sm text-zinc-200" data-testid="amux-workers-done">
          {changeWorker === null ? null : m.change.done(changeWorker)}
        </p>
      );
    }
    // A refusal or a failure of a single change has its own line; the notice only adds what is unknown.
    const text = lastRun === "seed"
      ? { done: m.seed.done, stopped: m.seed.stopped, outcome_unknown: m.seed.outcomeUnknown, unread: m.seed.unread }[notice]
      : { done: null, stopped: null, outcome_unknown: m.change.outcomeUnknown, unread: m.change.unread }[notice];
    if (text === null) return null;
    const alarming = notice === "outcome_unknown" || notice === "unread";
    return (
      <p
        role={alarming ? "alert" : "status"}
        className={`text-sm ${alarming ? "text-amber-300" : "text-zinc-200"}`}
        data-testid={`amux-workers-notice-${notice}`}
      >
        {text}
      </p>
    );
  })();

  const drawerKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") onOpen(null);
  };

  const drawer = (row: AmuxWorkerOverviewRow): ReactNode => {
    const ageText = amuxWorkerAgeText(m, row.heartbeatAgeSeconds);
    const liveKey: AgentOfficeAmuxWorkerState | "unread" = row.live ?? "unread";
    const connection = (m.drawer.connectionLine[liveKey] as (age: string | null) => string)(ageText);
    const work = row.live === "busy" ? m.drawer.workBusy
      : row.live === "ready" || row.live === "idle" || row.live === "starting" ? m.drawer.workNone
      : m.drawer.workUnknown;
    const command = amuxWorkerEnableCommand(row.workerName);
    const form = editing !== null && editing.workerName === row.workerName ? editing : null;
    const canEdit = canChange && overview.capabilitiesReadable && row.capability !== null && row.desiredState !== "retired";
    return (
      <div className="fixed inset-0 z-50 flex justify-end" data-testid="amux-worker-drawer-layer">
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className="absolute inset-0 bg-black/50"
          onClick={() => onOpen(null)}
          data-testid="amux-worker-drawer-backdrop"
        />
        <aside
          role="dialog"
          aria-modal="true"
          aria-labelledby="amux-worker-drawer-title"
          className="relative flex h-full w-full max-w-[34rem] flex-col overflow-y-auto border-l border-zinc-700 bg-zinc-900 text-zinc-100"
          onKeyDown={drawerKey}
          data-testid="amux-worker-drawer"
        >
          <header className="flex items-start justify-between gap-3 border-b border-zinc-700 p-5">
            <div className="min-w-0">
              <h3 id="amux-worker-drawer-title" className="break-all font-mono text-lg font-bold">{row.workerName}</h3>
              <p className="mt-1 text-sm text-zinc-400">
                {m.mode[row.mode]} · {row.providerLabel} · {m.drawer.registered(brisbaneTime.format(new Date(row.changedAt)))}
              </p>
              <span className={`mt-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE_PILL[row.tone]}`}>
                <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[row.tone]}`} />
                {m.status[row.status]}
              </span>
            </div>
            <button
              type="button"
              className={buttonClass}
              autoFocus
              aria-label={m.drawer.close}
              onClick={() => onOpen(null)}
              data-testid="amux-worker-drawer-close"
            >
              {m.drawer.close}
            </button>
          </header>

          <div className="flex flex-col gap-6 p-5">
            <section aria-labelledby="amux-worker-drawer-now" className="flex flex-col gap-2">
              <h4 id="amux-worker-drawer-now" className="text-base font-semibold">{m.drawer.nowTitle}</h4>
              <p className="text-sm text-zinc-300" data-testid="amux-worker-drawer-reason">{amuxWorkerReasonText(m, row)}</p>
              <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt className="text-zinc-400">{m.drawer.connection}</dt>
                <dd className="font-semibold" data-testid="amux-worker-drawer-connection">{connection}</dd>
                <dt className="text-zinc-400">{m.drawer.work}</dt>
                <dd className="font-semibold">{work}</dd>
                <dt className="text-zinc-400">{m.drawer.process}</dt>
                <dd className="break-all font-mono text-xs font-semibold" data-testid="amux-worker-drawer-process">{amuxWorkerBridgeUnit(row.workerName)}</dd>
              </dl>
            </section>

            <section aria-labelledby="amux-worker-drawer-capability" className="flex flex-col gap-3">
              <h4 id="amux-worker-drawer-capability" className="text-base font-semibold">{m.drawer.capabilityTitle}</h4>
              <p className="text-sm text-zinc-400">{m.drawer.capabilityHelp}</p>
              <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt className="text-zinc-400">{m.drawer.roleCeiling}</dt>
                <dd className="font-mono text-xs font-semibold">{row.roleCeiling}</dd>
                <dt className="text-zinc-400">{m.drawer.model}</dt>
                <dd className="flex flex-wrap items-center gap-1">
                  <span className="break-all font-mono text-xs font-semibold">{usedModel(row) ?? m.drawer.none}</span>
                  <AmuxCliModelIssueChips m={cm} cliModels={models} cli={row.providerClass} model={usedModel(row)} />
                </dd>
                <dt className="text-zinc-400">{m.drawer.tags}</dt>
                <dd className="flex flex-wrap gap-1">
                  {row.routingTags.length === 0 ? <span className="text-xs">{m.drawer.none}</span> : row.routingTags.map((tag) => <span key={tag} className={chipClass}>{tag}</span>)}
                </dd>
              </dl>
              <p className="text-sm text-zinc-300">{row.mode === "v22" ? m.drawer.v22On : m.drawer.v22Off}</p>
              {form !== null && row.capability !== null ? (
                <AmuxWorkerCapabilityEditor
                  m={cm}
                  row={row.capability}
                  form={form}
                  busy={capabilityBusy}
                  writesLatch={writesLatch}
                  cliModels={models}
                  onChange={onEditChange}
                  onCancel={onEditCancel}
                  onSave={onEditSave}
                />
              ) : canEdit ? (
                <button
                  type="button"
                  className={`${buttonClass} w-fit`}
                  disabled={capabilityBusy || busy}
                  onClick={() => onEditStart(row.capability!)}
                  data-testid="amux-worker-drawer-edit-capability"
                >
                  {m.drawer.editCapability}
                </button>
              ) : null}
              {capabilityNotice === "done" ? <p role="status" className="text-sm" data-testid="amux-worker-capability-done">{cm.importDone}</p> : null}
              {capabilityNotice === "stopped" ? <p role="status" className="text-sm" data-testid="amux-worker-capability-stopped">{cm.importStopped}</p> : null}
              {capabilityNotice === "outcome_unknown" ? (
                <p role="alert" className="text-sm text-amber-300" data-testid="amux-worker-capability-outcome-unknown">{cm.importOutcomeUnknown}</p>
              ) : null}
              {capabilityNotice === "unread" ? (
                <p role="alert" className="text-sm text-amber-300" data-testid="amux-worker-capability-run-unread">{cm.importUnread}</p>
              ) : null}
              {capabilityRefusal ? (
                <p role="alert" className="text-sm text-red-300" data-testid="amux-worker-capability-refused">
                  {cm.importRefused(capabilityRefusal.workerName, capabilityRefusal.code)}
                </p>
              ) : null}
              {capabilityFailure ? <AdminApiFailureNotice failure={capabilityFailure} /> : null}
            </section>

            <section aria-labelledby="amux-worker-drawer-switch" className="flex flex-col gap-3 border-t border-zinc-700 pt-5">
              <h4 id="amux-worker-drawer-switch" className="text-base font-semibold">{m.drawer.switchTitle}</h4>
              {canChange && row.actions.length > 0 ? (
                <div className="flex flex-wrap gap-2">{changeButtons(row)}</div>
              ) : (
                <p className="text-sm text-zinc-300" data-testid="amux-worker-drawer-read-only">
                  {!isOwner ? m.drawer.readOnlyNote : !writesLatch ? m.writesOff : m.drawer.none}
                </p>
              )}
              <p className="text-sm text-zinc-400">{m.drawer.switchHelp}</p>
              {lastRun === "change" && refusal !== null && refusal.workerName === row.workerName ? (
                <p role="alert" className="text-sm text-red-300" data-testid="amux-workers-refused">
                  {m.change.refused(refusal.workerName, refusalSentence(m, refusal.code))}
                </p>
              ) : null}
              {lastRun === "change" && failure ? <AdminApiFailureNotice failure={failure} /> : null}
            </section>

            <section aria-labelledby="amux-worker-drawer-host" className="flex flex-col gap-2 border-t border-zinc-700 pt-5">
              <h4 id="amux-worker-drawer-host" className="text-base font-semibold">{m.drawer.hostTitle}</h4>
              <p className="text-sm text-zinc-400">{m.drawer.hostHelp}</p>
              <div className="flex items-start justify-between gap-3 rounded-lg bg-zinc-950 p-3">
                <code className="min-w-0 break-all font-mono text-xs text-zinc-100" data-testid="amux-worker-drawer-command">{command}</code>
                <button type="button" className={`${buttonClass} shrink-0`} onClick={() => onCopy(command)} data-testid="amux-worker-drawer-copy">
                  {copied ? m.drawer.copied : m.drawer.copy}
                </button>
              </div>
            </section>
          </div>
          <footer className="mt-auto border-t border-zinc-700 p-5 text-xs text-zinc-400">{m.drawer.ownerNote}</footer>
        </aside>
      </div>
    );
  };

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4" data-testid="amux-workers-overview">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">{m.title}</h2>
        <p className="mt-1 text-sm text-zinc-300">{m.description}</p>
      </div>
      {isOwner ? (writesLatch ? null : <p className="text-sm text-amber-300" data-testid="amux-workers-writes-off">{m.writesOff}</p>) : (
        <p className="text-sm text-zinc-300" data-testid="amux-workers-read-only">{m.readOnly}</p>
      )}
      {overview.liveReadable ? null : <p role="alert" className="text-sm text-amber-300" data-testid="amux-workers-live-unread">{m.liveUnread}</p>}
      {overview.capabilitiesReadable ? null : <p role="alert" className="text-sm text-amber-300" data-testid="amux-workers-capabilities-unread">{m.capabilitiesUnread}</p>}

      <div className="grid gap-3 md:grid-cols-3" data-testid="amux-workers-summary">
        {card("assignable", m.summary.assignable, summary.assignable.count, assignableDetail, "ok")}
        {card("attention", m.summary.attention, summary.attention.count, attentionDetail, "attention")}
        {card("waiting", m.summary.waiting, summary.waiting.count, waitingDetail, "neutral")}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label={m.filters.label}>
          {AMUX_WORKER_OVERVIEW_FILTERS.map((entry) => (
            <button
              key={entry}
              type="button"
              aria-pressed={filter === entry}
              onClick={() => onFilter(entry)}
              className={`min-h-11 rounded-full border px-3 text-sm ${filter === entry ? "border-zinc-100 bg-zinc-100 text-zinc-900" : "border-zinc-600 text-zinc-200"}`}
              data-testid={`amux-workers-filter-${entry}`}
            >
              {m.filters[entry]} {amuxWorkerFilterCount(rows, entry)}
            </button>
          ))}
        </div>
        <label className="w-full sm:w-64">
          <span className="sr-only">{m.search}</span>
          <input
            type="search"
            value={query}
            maxLength={40}
            placeholder={m.search}
            onChange={(event) => onQuery(event.target.value)}
            className="min-h-11 w-full rounded-md border border-zinc-600 bg-zinc-900 px-3 text-base text-zinc-100"
            data-testid="amux-workers-search"
          />
        </label>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-zinc-300" data-testid="amux-workers-empty">{m.empty}</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-zinc-300" data-testid="amux-workers-no-match">{m.noMatch}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-700" data-testid="amux-workers-table-scroll">
          <table className="w-full min-w-[56rem] border-collapse text-left text-sm text-zinc-100">
            <thead>
              <tr className="text-xs font-semibold text-zinc-400">
                <th scope="col" className="px-3 py-2">{m.column.worker}</th>
                <th scope="col" className="px-3 py-2">{m.column.status}</th>
                <th scope="col" className="px-3 py-2">{m.column.role}</th>
                <th scope="col" className="px-3 py-2">{m.column.capability}</th>
                <th scope="col" className="px-3 py-2 text-right">{m.column.next}</th>
              </tr>
            </thead>
            {groups.map(({ group, rows: groupRows }) => (
              <tbody key={group} data-testid={`amux-workers-group-${group}`}>
                <tr className="bg-zinc-800/60">
                  <th scope="colgroup" colSpan={5} className="px-3 py-2 text-left text-xs font-bold text-zinc-200">
                    {m.groupTitle[group]} {groupRows.length}
                  </th>
                </tr>
                {groupRows.map((row) => (
                  <tr key={row.workerName} className="border-t border-zinc-700 align-top" data-testid={`amux-worker-row-${row.workerName}`}>
                    <th scope="row" className="px-3 py-3 text-left font-normal">
                      <div className="font-mono text-sm font-semibold">{row.workerName}</div>
                      <div className="text-xs text-zinc-400">{m.mode[row.mode]} · {row.providerLabel}</div>
                    </th>
                    <td className="px-3 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE_PILL[row.tone]}`} data-testid={`amux-worker-status-${row.workerName}`}>
                        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[row.tone]}`} />
                        {m.status[row.status]}
                      </span>
                      <p className="mt-1 max-w-xs text-sm text-zinc-300" data-testid={`amux-worker-reason-${row.workerName}`}>{amuxWorkerReasonText(m, row)}</p>
                    </td>
                    <td className="px-3 py-3"><span className={chipClass}>{row.roleCeiling}</span></td>
                    <td className="px-3 py-3">
                      <div className="flex max-w-xs flex-wrap gap-1">
                        {row.model === null && row.routingTags.length === 0 ? (
                          <span className="text-xs text-zinc-400">{m.noCapability}</span>
                        ) : (
                          <>
                            {usedModel(row) === null ? null : <span className={chipClass}>{usedModel(row)}</span>}
                            <AmuxCliModelIssueChips
                              m={cm}
                              cliModels={models}
                              cli={row.providerClass}
                              model={usedModel(row)}
                              onFix={fixable(row) ? () => onFix!(row) : undefined}
                            />
                            {row.routingTags.map((tag) => <span key={tag} className={chipClass}>{tag}</span>)}
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap justify-end gap-2">
                        {changeButtons(row)}
                        <button
                          type="button"
                          className={buttonClass}
                          aria-label={m.actions.detailsLabel(row.workerName)}
                          onClick={() => onOpen(row.workerName)}
                          data-testid={`amux-worker-details-${row.workerName}`}
                        >
                          {m.actions.details}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}

      {seedEntries !== null && seedEntries.length > 0 ? (
        <details className="rounded-xl border border-zinc-700 p-4" data-testid="amux-workers-seed">
          <summary className="min-h-11 cursor-pointer text-sm font-semibold text-zinc-100">{m.seed.title}</summary>
          <div className="mt-3 flex flex-col gap-3">
            <p className="text-sm text-zinc-300">{m.seed.help}</p>
            <ul className="list-disc pl-5 text-sm text-zinc-300">
              {seedEntries.map((entry) => (
                <li key={entry.workerName}>
                  <span className="font-mono text-xs">{entry.workerName}</span> · {entry.desiredState} · {entry.roleCeiling}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={`${buttonClass} w-fit`}
              disabled={busy || !writesLatch}
              onClick={() => onSeed(seedEntries)}
              data-testid="amux-workers-seed-register"
            >
              {pending !== null && pending !== "reading" && lastRun === "seed"
                ? m.seed.registering(pending.done, pending.total)
                : m.seed.register(seedEntries.length)}
            </button>
          </div>
        </details>
      ) : null}

      {canChange && onRegister !== undefined ? (
        <AmuxWorkerRegisterForm m={m} busy={busy} taken={new Set(rows.map((row) => row.workerName))} onRegister={onRegister} />
      ) : null}

      {runNotice}
      {lastRun === "seed" && refusal ? (
        <p role="alert" className="text-sm text-red-300" data-testid="amux-workers-seed-refused">
          {m.seed.refused(refusal.workerName, refusalSentence(m, refusal.code))}
        </p>
      ) : null}
      {lastRun === "seed" && failure ? <AdminApiFailureNotice failure={failure} /> : null}
      {lastRun === "change" && refusal && (openRow === null || openRow.workerName !== refusal.workerName) ? (
        <p role="alert" className="text-sm text-red-300" data-testid="amux-workers-refused">
          {m.change.refused(refusal.workerName, refusalSentence(m, refusal.code))}
        </p>
      ) : null}
      {lastRun === "change" && openRow === null && failure ? <AdminApiFailureNotice failure={failure} /> : null}

      {openRow === null ? null : drawer(openRow)}
    </section>
  );
}

/**
 * The view with its state and requests. A change needs the owner role, the
 * stage's code latch and a recent step-up, all checked by the route; a stale
 * step-up is answered 428 and rendered with the way back
 * (`AdminApiFailureNotice`, docs/ui-contracts/admin-console-ia.md rule 7).
 */
export function AmuxWorkersOverviewPanel({
  registry,
  capabilities,
  live,
  readAtMs,
  isOwner,
}: {
  registry: AmuxWorkerRegistryAdminView | null;
  capabilities: AmuxWorkerCapabilityAdminView | null;
  live: AgentOfficeAmuxState | null;
  /** When the server read the three sources; ages are counted from here. */
  readAtMs: number;
  isOwner: boolean;
}) {
  const m = useAdminMessages(adminAmuxWorkersMessages) as Messages;
  const cm = useAdminMessages(adminAmuxWorkerCapabilityMessages) as CapabilityMessages;
  const { locale } = useAdminLocale();
  const router = useRouter();

  // The registry and the capabilities are read again after every change, so
  // the screen follows what the server answered; the live reading comes from
  // the page and is refreshed with it.
  const [registryView, setRegistryView] = useState<AmuxWorkerRegistryAdminView | null>(registry);
  const [capabilityView, setCapabilityView] = useState<AmuxWorkerCapabilityAdminView | null>(capabilities);
  const [filter, setFilter] = useState<AmuxWorkerOverviewFilter>("all");
  const [query, setQuery] = useState("");
  const [openWorker, setOpenWorker] = useState<string | null>(null);
  const [pending, setPending] = useState<AmuxWorkerRegistryPending>(null);
  const [notice, setNotice] = useState<AmuxWorkerRegistryNotice>(null);
  const [refusal, setRefusal] = useState<AmuxWorkerRegistryRefusal>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [lastRun, setLastRun] = useState<"seed" | "change" | null>(null);
  const [changeWorker, setChangeWorker] = useState<string | null>(null);
  const [editing, setEditing] = useState<AmuxWorkerCapabilityForm | null>(null);
  const [capabilityPending, setCapabilityPending] = useState(false);
  const [capabilityNotice, setCapabilityNotice] = useState<AmuxWorkerCapabilityNotice>(null);
  const [capabilityRefusal, setCapabilityRefusal] = useState<AmuxWorkerCapabilityRefusalNotice>(null);
  const [capabilityFailure, setCapabilityFailure] = useState<AdminApiFailure | null>(null);
  const [copied, setCopied] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  const overview = useMemo(
    () => buildAmuxWorkerOverview({ registry: registryView, capabilities: capabilityView, live, nowMs: readAtMs }),
    [registryView, capabilityView, live, readAtMs],
  );

  const applyRegistry = (changes: AmuxWorkerRegistryUpdate) => {
    if ("view" in changes) setRegistryView(changes.view ?? null);
    if ("notice" in changes) setNotice(changes.notice ?? null);
    if ("refusal" in changes) setRefusal(changes.refusal ?? null);
    if ("failure" in changes) setFailure(changes.failure ?? null);
    if ("pending" in changes) setPending(changes.pending ?? null);
  };

  const registryIo: AmuxWorkerRegistryIo = {
    post: (request) =>
      adminFetch(REGISTRY_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    read: async () => {
      try {
        const response = await adminFetch(REGISTRY_PATH, { method: "GET" });
        return response.ok ? parseAmuxWorkerRegistryAdminView(await response.json().catch(() => null)) : null;
      } catch {
        return null;
      }
    },
    failureOf: (response) => readAdminApiFailure(response, { fallback: m.change.failed, locale }),
    networkFailure: () => adminNetworkFailure(locale),
  };

  const applyCapability = (changes: AmuxWorkerCapabilityUpdate) => {
    if ("view" in changes) {
      const next = changes.view ?? null;
      setCapabilityView(next);
      // A worker that left the list cannot be edited, and its editor would
      // no longer render a way out: let the edit go.
      if (next !== null) {
        setEditing((form) => (form !== null && next.rows.some((row) => row.workerName === form.workerName) ? form : null));
      }
    }
    if ("notice" in changes) setCapabilityNotice(changes.notice ?? null);
    if ("refusal" in changes) setCapabilityRefusal(changes.refusal ?? null);
    if ("failure" in changes) setCapabilityFailure(changes.failure ?? null);
    if ("pending" in changes) setCapabilityPending(changes.pending !== null && changes.pending !== undefined);
  };

  const capabilityIo: AmuxWorkerCapabilityIo = {
    post: (entry) =>
      adminFetch(AMUX_WORKER_CAPABILITY_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry),
      }),
    read: async () => {
      try {
        const response = await adminFetch(AMUX_WORKER_CAPABILITY_PATH, { method: "GET" });
        return response.ok ? parseAmuxWorkerCapabilityAdminView(await response.json().catch(() => null)) : null;
      } catch {
        return null;
      }
    },
    failureOf: (response) => readAdminApiFailure(response, { fallback: cm.changeFailed, locale }),
    networkFailure: () => adminNetworkFailure(locale),
  };

  const closeDrawer = () => {
    setOpenWorker(null);
    setEditing(null);
    setCapabilityNotice(null);
    setCapabilityRefusal(null);
    setCapabilityFailure(null);
    setCopied(false);
    // Focus goes back to the control that opened the drawer.
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target !== null) window.requestAnimationFrame(() => target.focus());
  };

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const seedEntries = isOwner && registryView !== null ? amuxWorkerSeedEntriesToRegister(registryView) : null;

  return (
    <AmuxWorkersOverviewView
      m={m}
      cm={cm}
      overview={overview}
      isOwner={isOwner}
      writesLatch={registryView?.writesLatch ?? false}
      filter={filter}
      query={query}
      openWorker={openWorker}
      pending={pending}
      notice={notice}
      lastRun={lastRun}
      changeWorker={changeWorker}
      refusal={refusal}
      failure={failure}
      seedEntries={seedEntries}
      editing={editing}
      capabilityBusy={capabilityPending}
      capabilityNotice={capabilityNotice}
      capabilityRefusal={capabilityRefusal}
      capabilityFailure={capabilityFailure}
      copied={copied}
      onFilter={setFilter}
      onQuery={setQuery}
      onOpen={(workerName) => {
        if (workerName === null) {
          closeDrawer();
          return;
        }
        if (openWorker === null && typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
          returnFocus.current = document.activeElement;
        }
        setOpenWorker(workerName);
        setEditing(null);
        setCapabilityNotice(null);
        setCapabilityRefusal(null);
        setCapabilityFailure(null);
        setNotice(null);
        setRefusal(null);
        setFailure(null);
      }}
      onAction={(row, action) => {
        setLastRun("change");
        setChangeWorker(row.workerName);
        void runAmuxWorkerStateChange(
          {
            workerName: row.workerName,
            providerClass: row.providerClass,
            roleCeiling: row.roleCeiling,
            desiredState: AMUX_WORKER_ACTION_TARGET[action],
            expectedRevision: row.revision,
          },
          registryIo,
          applyRegistry,
        ).then(() => router.refresh());
      }}
      onSeed={(entries) => {
        setLastRun("seed");
        void runAmuxWorkerSeedRegistration(entries, registryIo, applyRegistry).then(() => router.refresh());
      }}
      onReread={() => void runAmuxWorkerRegistryReread(registryIo, applyRegistry)}
      onEditStart={(row) => setEditing(amuxWorkerCapabilityFormFromRow(row))}
      onEditChange={setEditing}
      onEditCancel={() => setEditing(null)}
      onEditSave={(form) => {
        const row = capabilityView?.rows.find((candidate) => candidate.workerName === form.workerName);
        if (!row) return;
        void runAmuxWorkerCapabilityEdit(row, form, capabilityIo, applyCapability).then((saved) => {
          if (saved) {
            setEditing(null);
            router.refresh();
          }
        });
      }}
      cliModels={capabilityView?.cliModels ?? null}
      onFix={(row) => {
        if (openWorker === null && typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
          returnFocus.current = document.activeElement;
        }
        setOpenWorker(row.workerName);
        setCapabilityNotice(null);
        setCapabilityRefusal(null);
        setCapabilityFailure(null);
        setEditing(row.capability === null ? null : amuxWorkerCapabilityFormFromRow(row.capability));
      }}
      onRegister={(request) => {
        setLastRun("change");
        setChangeWorker(request.workerName);
        void runAmuxWorkerRegistration(request, registryIo, applyRegistry).then(async () => {
          // A new worker also has a capability row to edit.
          applyCapability({ view: await capabilityIo.read() });
          router.refresh();
        });
      }}
      onCopy={(command) => {
        try {
          void navigator.clipboard.writeText(command).then(() => setCopied(true), () => setCopied(false));
        } catch {
          setCopied(false);
        }
      }}
    />
  );
}
