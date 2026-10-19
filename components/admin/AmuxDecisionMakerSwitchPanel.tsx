"use client";

import { Bot, Power } from "lucide-react";
import { useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import {
  adminNetworkFailure,
  readAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxDecisionMakerMessages } from "@/lib/adminMessages/amuxDecisionMaker";
import type { DmAdminSwitchLatches } from "@/lib/amux/decisionMakerAdminCore";
import {
  DM_INSTANCE_MODES,
  DM_INSTANCE_SCOPES,
  DM_KILL_SWITCH_SCOPE,
  DM_KILL_SWITCH_VALUES,
  isDmInstanceScope,
  type DecisionMakerSwitchState,
  type DmInstanceMode,
  type DmSwitchLatchReason,
  type DmSwitchScope,
} from "@/lib/amux/decisionMakerSwitchCore";

const SWITCH_PATH = "/api/admin/amux/decision-maker/switches";

type Messages = (typeof adminAmuxDecisionMakerMessages)["en"];

export type DmSwitchChange = { scope: DmSwitchScope; value: string };

/** What is in flight: one change, or a read of the state. */
export type DmSwitchPending = DmSwitchChange | "reading" | null;

/**
 * What the last change came back as. `_unread` means the state could not be
 * read again afterwards, so the screen shows no state at all.
 */
export type DmSwitchNotice =
  | "saved"
  | "saved_unread"
  | "outcome_unknown"
  | "outcome_unknown_unread"
  | "invalid_change"
  | null;

/**
 * The values a person may set on a scope: every value the policy allows
 * except the one it holds. An unreadable scope offers every value, because
 * the person is the only one who can put it back into a known state.
 */
export const dmSwitchChangesFor = (
  scope: DmSwitchScope,
  current: string | null,
): DmSwitchChange[] => {
  const values: readonly string[] =
    scope === DM_KILL_SWITCH_SCOPE ? DM_KILL_SWITCH_VALUES : DM_INSTANCE_MODES;
  return values.filter((value) => value !== current).map((value) => ({ scope, value }));
};

/**
 * The switch route's GET body, or `null` when it is not exactly that shape.
 * A field the route reports as unreadable stays `null`; anything else that
 * does not match is a failed read, never a guessed state.
 */
export const parseDmSwitchStateResponse = (body: unknown): DecisionMakerSwitchState | null => {
  if (body === null || typeof body !== "object") return null;
  const { killSwitch, instances } = body as { killSwitch?: unknown; instances?: unknown };
  if (killSwitch !== null && typeof killSwitch !== "boolean") return null;
  if (instances === null || typeof instances !== "object") return null;
  const parsed = {} as Record<(typeof DM_INSTANCE_SCOPES)[number], DmInstanceMode | null>;
  for (const scope of DM_INSTANCE_SCOPES) {
    const mode = (instances as Record<string, unknown>)[scope];
    if (mode !== null && !(DM_INSTANCE_MODES as readonly unknown[]).includes(mode)) return null;
    parsed[scope] = mode as DmInstanceMode | null;
  }
  if (Object.keys(instances).length !== DM_INSTANCE_SCOPES.length) return null;
  return { killSwitch, instances: parsed };
};

const killSwitchValue = (state: DecisionMakerSwitchState): "on" | "off" | null =>
  state.killSwitch === null ? null : state.killSwitch ? "on" : "off";

const changeLabel = (m: Messages, change: DmSwitchChange) =>
  change.scope === DM_KILL_SWITCH_SCOPE
    ? m.setKillSwitch[change.value as "on" | "off"]
    : m.setInstance[change.value as "off" | "proposal"];

const valueText = (m: Messages, value: string | null) =>
  value === null ? m.unreadable : `${m.value[value as keyof Messages["value"]]} (${value})`;

/**
 * The reason the system turned an instance off, shown only while the instance
 * is still off: a mode a person set since has no reason, and the kill switch
 * is never latched.
 */
const latchReason = (
  latches: DmAdminSwitchLatches | null,
  row: { scope: DmSwitchScope; current: string | null },
): DmSwitchLatchReason | null =>
  latches !== null && isDmInstanceScope(row.scope) && row.current === "off" ? latches[row.scope] : null;

/** The value pill: the kill switch on and an unreadable scope are the two that need a person. */
const valueTone = (kill: boolean, value: string | null) =>
  value === null ? "border-amber-800 bg-amber-950/50 text-amber-200"
    : kill ? (value === "on" ? "border-red-800 bg-red-950/50 text-red-200" : "border-emerald-800 bg-emerald-950/50 text-emerald-200")
      : value === "proposal" ? "border-sky-800 bg-sky-950/50 text-sky-200" : "border-zinc-700 bg-zinc-800 text-zinc-300";
const buttonBase = "inline-flex min-h-11 items-center rounded-lg border px-4 text-sm font-medium disabled:opacity-60";
const buttonClass = `${buttonBase} border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700`;
const dangerButtonClass = `${buttonBase} border-red-800 text-red-200 hover:bg-red-950/50`;

/**
 * AMUX › Execution › Decision Maker, without hooks, so a test can call it and
 * read the tree it returns.
 *
 * `state` is what was last read, or `null` when nothing current is known --
 * the server could not read it, or a read after a change failed. With no
 * state nothing can be changed: the only control is reading it again, so a
 * person never acts on a state the screen cannot vouch for. A change is only
 * ever one of `dmSwitchChangesFor()`, only for a viewer who may change, and
 * no control is enabled while anything is in flight.
 */
export function AmuxDecisionMakerSwitchView({
  m,
  state,
  canChange,
  pending,
  notice,
  failure,
  onChange,
  onReread,
  latches = null,
}: {
  m: Messages;
  state: DecisionMakerSwitchState | null;
  /**
   * Why the system turned an instance off, as read with `state` (stage S2-4c);
   * null when nothing is known, and then no reason is shown.
   */
  latches?: DmAdminSwitchLatches | null;
  canChange: boolean;
  pending: DmSwitchPending;
  notice: DmSwitchNotice;
  failure: AdminApiFailure | null;
  onChange: (change: DmSwitchChange) => void;
  onReread: () => void;
}) {
  const rows: Array<{ scope: DmSwitchScope; label: string; current: string | null }> =
    state === null
      ? []
      : [
          { scope: DM_KILL_SWITCH_SCOPE, label: m.killSwitch, current: killSwitchValue(state) },
          ...DM_INSTANCE_SCOPES.map((scope) => ({
            scope,
            label: `${m.instance} ${scope}`,
            current: state.instances[scope],
          })),
        ];
  const unread = notice === "saved_unread" || notice === "outcome_unknown_unread";
  return (
    <section
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-5"
      data-testid="amux-decision-maker-switch-panel"
    >
      <header className="flex flex-col gap-1.5">
        <h2 className="text-base font-bold text-zinc-100">{m.title}</h2>
        <p className="text-sm leading-6 text-zinc-400">{m.description}</p>
      </header>
      {canChange ? null : (
        <p className="text-sm text-zinc-300" data-testid="amux-dm-switch-read-only">
          {m.readOnly}
        </p>
      )}
      {state === null ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-300" data-testid="amux-dm-switch-unavailable">
            {unread ? m.rereadFailed : m.stateUnavailable}
          </p>
          <button
            type="button"
            className={`${buttonClass} w-fit`}
            disabled={pending !== null}
            onClick={onReread}
            data-testid="amux-dm-switch-reread"
          >
            {pending === "reading" ? m.reading : m.reread}
          </button>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {rows.map((row) => {
            const kill = row.scope === DM_KILL_SWITCH_SCOPE;
            const latched = latchReason(latches, row);
            return (
              <li
                key={row.scope}
                className={`flex min-w-0 flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4 ${kill ? "sm:col-span-2" : ""}`}
                data-testid={`amux-dm-switch-${row.scope}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {kill ? <Power className="h-4 w-4 text-zinc-400" aria-hidden /> : <Bot className="h-4 w-4 text-zinc-400" aria-hidden />}
                  <span className={`min-w-0 flex-1 break-words text-sm font-semibold text-zinc-100 ${kill ? "" : "font-mono"}`}>
                    {kill ? row.label : row.scope}
                  </span>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${valueTone(kill, row.current)}`}
                    data-testid={`amux-dm-switch-value-${row.scope}`}
                  >
                    {valueText(m, row.current)}
                  </span>
                </div>
                <p className="text-xs leading-5 text-zinc-400">{kill ? m.killSwitchHelp : m.instanceHelp}</p>
                {latched !== null ? (
                  <p
                    className="rounded-md border border-amber-800 bg-amber-950/50 px-3 py-2 text-xs text-amber-200"
                    data-testid={`amux-dm-switch-latch-${row.scope}`}
                    data-latch-reason={latched}
                  >
                    {m.latchReasons[latched as DmSwitchLatchReason]}
                  </p>
                ) : null}
                {canChange ? (
                  <div className="flex flex-wrap gap-2">
                    {dmSwitchChangesFor(row.scope, row.current).map((change) => (
                      <button
                        key={change.value}
                        type="button"
                        className={kill && change.value === "on" ? dangerButtonClass : buttonClass}
                        disabled={pending !== null}
                        onClick={() => onChange(change)}
                        data-testid={`amux-dm-switch-set-${row.scope}-${change.value}`}
                      >
                        {pending !== null &&
                        pending !== "reading" &&
                        pending.scope === change.scope &&
                        pending.value === change.value
                          ? m.saving
                          : changeLabel(m, change)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {notice === "saved" ? (
        <p role="status" className="text-sm text-zinc-300" data-testid="amux-dm-switch-saved">
          {m.saved}
        </p>
      ) : null}
      {notice === "saved_unread" ? (
        <p role="status" className="text-sm text-zinc-300" data-testid="amux-dm-switch-saved">
          {m.savedUnread}
        </p>
      ) : null}
      {notice === "outcome_unknown" || notice === "outcome_unknown_unread" ? (
        <p role="alert" className="text-sm text-amber-300" data-testid="amux-dm-switch-outcome-unknown">
          {notice === "outcome_unknown" ? m.outcomeUnknown : m.outcomeUnknownUnread}
        </p>
      ) : null}
      {notice === "invalid_change" ? (
        <p role="alert" className="text-sm text-red-300">
          {m.invalidChange}
        </p>
      ) : null}
      {failure ? <AdminApiFailureNotice failure={failure} returnTo="/admin/amux-settings?tab=decision-maker" /> : null}
    </section>
  );
}

/** One step of a change or a read, applied to the panel's state in order. */
export type DmSwitchUpdate = Partial<{
  pending: DmSwitchPending;
  notice: DmSwitchNotice;
  failure: AdminApiFailure | null;
  state: DecisionMakerSwitchState | null;
}>;

export type DmSwitchIo = {
  post: (change: DmSwitchChange) => Promise<Response>;
  /** The state as the route answers it now, or `null` when it cannot be read. */
  read: () => Promise<DecisionMakerSwitchState | null>;
  failureOf: (response: Response) => Promise<AdminApiFailure>;
  networkFailure: () => AdminApiFailure;
};

/**
 * Statuses the switch route answers before its transaction starts (a bad or
 * oversized body, no session or permission, a stale step-up, the rate limit),
 * or that a proxy answers without reaching it. Nothing was written.
 */
const DM_SWITCH_NO_WRITE_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 413, 428, 429]);

/** The JSON `error` of a refusal, or `null` when the body cannot be read. */
const refusalError = async (response: Response): Promise<unknown> => {
  try {
    const body = (await response.clone().json()) as { error?: unknown } | null;
    return body?.error ?? null;
  } catch {
    return null;
  }
};

/**
 * One change, start to finish. It is sent once. The state shown is kept only
 * when the answer proves nothing was written: one of
 * `DM_SWITCH_NO_WRITE_STATUSES`, or a 503 whose body was read and says the
 * change was rolled back (`switch_change_failed`). Every other answer --
 * saved, `outcome_unknown`, a body that could not be read, any other status,
 * or no answer at all -- may mean it was recorded, so the state is read again,
 * and only after that read has landed (or failed, leaving no state) is
 * anything released.
 */
export async function runDmSwitchChange(
  next: DmSwitchChange,
  io: DmSwitchIo,
  update: (changes: DmSwitchUpdate) => void,
): Promise<void> {
  update({ pending: next, notice: null, failure: null });
  try {
    let outcome: "saved" | "outcome_unknown" | null = null;
    try {
      const response = await io.post(next);
      if (response.ok) {
        outcome = "saved";
      } else if (DM_SWITCH_NO_WRITE_STATUSES.has(response.status)) {
        if (response.status === 400 && (await refusalError(response)) === "invalid_change") {
          update({ notice: "invalid_change" });
        } else {
          update({ failure: await io.failureOf(response) });
        }
      } else if (response.status === 503 && (await refusalError(response)) === "switch_change_failed") {
        update({ failure: await io.failureOf(response) });
      } else {
        outcome = "outcome_unknown";
      }
    } catch {
      outcome = "outcome_unknown";
      update({ failure: io.networkFailure() });
    }
    if (outcome !== null) {
      update({ pending: "reading" });
      const state = await io.read();
      update({
        state,
        notice: state !== null ? outcome : outcome === "saved" ? "saved_unread" : "outcome_unknown_unread",
      });
    }
  } finally {
    update({ pending: null });
  }
}

/** Reading the state again on request; a failed read leaves no state. */
export async function runDmSwitchReread(
  io: Pick<DmSwitchIo, "read">,
  update: (changes: DmSwitchUpdate) => void,
): Promise<void> {
  update({ pending: "reading", failure: null });
  try {
    const state = await io.read();
    update(state === null ? { state } : { state, notice: null });
  } finally {
    update({ pending: null });
  }
}

/**
 * The view with its requests. A change needs `ops:write` and a recent
 * step-up, both checked by the route; a stale step-up is answered 428 and
 * rendered with the way back (`AdminApiFailureNotice`,
 * docs/ui-contracts/admin-console-ia.md rule 7). The sequencing is
 * `runDmSwitchChange()`'s: no control is released until the state has been
 * read again after a change that may have been recorded.
 */
export function AmuxDecisionMakerSwitchPanel({
  state,
  latches = null,
  canChange,
}: {
  state: DecisionMakerSwitchState | null;
  /** The reasons read with `state`; they describe that state only, so they are not shown after a change or a re-read. */
  latches?: DmAdminSwitchLatches | null;
  canChange: boolean;
}) {
  const m = useAdminMessages(adminAmuxDecisionMakerMessages) as Messages;
  const { locale } = useAdminLocale();
  const [current, setCurrent] = useState<DecisionMakerSwitchState | null>(state);
  const [pending, setPending] = useState<DmSwitchPending>(null);
  const [notice, setNotice] = useState<DmSwitchNotice>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);

  const apply = (changes: DmSwitchUpdate) => {
    if ("state" in changes) setCurrent(changes.state ?? null);
    if ("notice" in changes) setNotice(changes.notice ?? null);
    if ("failure" in changes) setFailure(changes.failure ?? null);
    if ("pending" in changes) setPending(changes.pending ?? null);
  };

  const io: DmSwitchIo = {
    post: (change) =>
      adminFetch(SWITCH_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: change.scope, value: change.value }),
      }),
    read: async () => {
      try {
        const response = await adminFetch(SWITCH_PATH, { method: "GET" });
        return response.ok
          ? parseDmSwitchStateResponse(await response.json().catch(() => null))
          : null;
      } catch {
        return null;
      }
    },
    failureOf: (response) => readAdminApiFailure(response, { fallback: m.changeFailed, locale }),
    networkFailure: () => adminNetworkFailure(locale),
  };

  return (
    <AmuxDecisionMakerSwitchView
      m={m}
      state={current}
      latches={current === state ? latches : null}
      canChange={canChange}
      pending={pending}
      notice={notice}
      failure={failure}
      onChange={(change) => void runDmSwitchChange(change, io, apply)}
      onReread={() => void runDmSwitchReread(io, apply)}
    />
  );
}
