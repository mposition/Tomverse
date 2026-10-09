"use client";

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
import {
  DM_INSTANCE_MODES,
  DM_INSTANCE_SCOPES,
  DM_KILL_SWITCH_SCOPE,
  DM_KILL_SWITCH_VALUES,
  type DecisionMakerSwitchState,
  type DmInstanceMode,
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

const cellClass = "border-b border-zinc-200 px-2 py-2 align-top dark:border-zinc-700";
const buttonClass =
  "inline-flex min-h-11 items-center rounded-md border border-zinc-400 px-3 py-1 text-xs font-bold disabled:opacity-60 dark:border-zinc-500";

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
}: {
  m: Messages;
  state: DecisionMakerSwitchState | null;
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
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4"
      data-testid="amux-decision-maker-switch-panel"
    >
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{m.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.description}</p>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.killSwitchHelp}</p>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.instanceHelp}</p>
      {canChange ? null : (
        <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-dm-switch-read-only">
          {m.readOnly}
        </p>
      )}
      {state === null ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="amux-dm-switch-unavailable">
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
        <table className="w-full border-collapse text-left text-sm text-zinc-900 dark:text-zinc-100">
          <tbody>
            {rows.map((row) => (
              <tr key={row.scope} data-testid={`amux-dm-switch-${row.scope}`}>
                <th scope="row" className={`${cellClass} font-medium`}>
                  {row.label}
                </th>
                <td className={cellClass} data-testid={`amux-dm-switch-value-${row.scope}`}>
                  {valueText(m, row.current)}
                </td>
                <td className={cellClass}>
                  {canChange ? (
                    <div className="flex flex-wrap gap-2">
                      {dmSwitchChangesFor(row.scope, row.current).map((change) => (
                        <button
                          key={change.value}
                          type="button"
                          className={buttonClass}
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {notice === "saved" ? (
        <p role="status" className="text-sm" data-testid="amux-dm-switch-saved">
          {m.saved}
        </p>
      ) : null}
      {notice === "saved_unread" ? (
        <p role="status" className="text-sm" data-testid="amux-dm-switch-saved">
          {m.savedUnread}
        </p>
      ) : null}
      {notice === "outcome_unknown" || notice === "outcome_unknown_unread" ? (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-300" data-testid="amux-dm-switch-outcome-unknown">
          {notice === "outcome_unknown" ? m.outcomeUnknown : m.outcomeUnknownUnread}
        </p>
      ) : null}
      {notice === "invalid_change" ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {m.invalidChange}
        </p>
      ) : null}
      {failure ? <AdminApiFailureNotice failure={failure} /> : null}
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
 * One change, start to finish. It is sent once. After any answer that may
 * mean it was recorded -- saved, an unknown outcome, or no answer at all --
 * the state is read again, and only after that read has landed (or failed,
 * leaving no state) is anything released. A refusal that wrote nothing
 * (403, 428, a rolled-back 503, an invalid value) leaves the state shown.
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
      } else {
        const body =
          response.status === 503 || response.status === 400
            ? ((await response.clone().json().catch(() => null)) as { error?: unknown } | null)
            : null;
        if (body?.error === "outcome_unknown") outcome = "outcome_unknown";
        else if (body?.error === "invalid_change") update({ notice: "invalid_change" });
        else update({ failure: await io.failureOf(response) });
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
  canChange,
}: {
  state: DecisionMakerSwitchState | null;
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
      canChange={canChange}
      pending={pending}
      notice={notice}
      failure={failure}
      onChange={(change) => void runDmSwitchChange(change, io, apply)}
      onReread={() => void runDmSwitchReread(io, apply)}
    />
  );
}
