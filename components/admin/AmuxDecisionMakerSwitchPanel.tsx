"use client";

import { useRouter } from "next/navigation";
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
  type DmSwitchScope,
} from "@/lib/amux/decisionMakerSwitchCore";

const SWITCH_PATH = "/api/admin/amux/decision-maker/switches";

type Messages = (typeof adminAmuxDecisionMakerMessages)["en"];

export type DmSwitchChange = { scope: DmSwitchScope; value: string };

/** What the last change came back as, for the line under the switches. */
export type DmSwitchNotice = "saved" | "outcome_unknown" | "invalid_change" | null;

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

const killSwitchValue = (state: DecisionMakerSwitchState): "on" | "off" | null =>
  state.killSwitch === null ? null : state.killSwitch ? "on" : "off";

const changeLabel = (m: Messages, change: DmSwitchChange) =>
  change.scope === DM_KILL_SWITCH_SCOPE
    ? m.setKillSwitch[change.value as "on" | "off"]
    : m.setInstance[change.value as "off" | "proposal"];

const valueText = (m: Messages, value: string | null) =>
  value === null ? m.unreadable : `${m.value[value as keyof Messages["value"]]} (${value})`;

const cellClass = "border-b border-zinc-200 px-2 py-2 align-top dark:border-zinc-700";

/**
 * AMUX › Execution › Decision Maker, without hooks, so a test can call it and
 * read the tree it returns. Everything shown was read on the server; a
 * change is only ever one of `dmSwitchChangesFor()`, and only when the
 * viewer may change switches at all.
 */
export function AmuxDecisionMakerSwitchView({
  m,
  state,
  canChange,
  pending,
  notice,
  failure,
  onChange,
}: {
  m: Messages;
  state: DecisionMakerSwitchState | null;
  canChange: boolean;
  pending: DmSwitchChange | null;
  notice: DmSwitchNotice;
  failure: AdminApiFailure | null;
  onChange: (change: DmSwitchChange) => void;
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
        <p role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="amux-dm-switch-unavailable">
          {m.stateUnavailable}
        </p>
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
                          className="inline-flex min-h-11 items-center rounded-md border border-zinc-400 px-3 py-1 text-xs font-bold disabled:opacity-60 dark:border-zinc-500"
                          disabled={pending !== null}
                          onClick={() => onChange(change)}
                          data-testid={`amux-dm-switch-set-${row.scope}-${change.value}`}
                        >
                          {pending?.scope === change.scope && pending.value === change.value
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
      {notice === "outcome_unknown" ? (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-300" data-testid="amux-dm-switch-outcome-unknown">
          {m.outcomeUnknown}
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

/**
 * The view with its one request. A change needs `ops:write` and a recent
 * step-up, both checked by the route; a stale step-up is answered 428 and
 * rendered with the way back (`AdminApiFailureNotice`,
 * docs/ui-contracts/admin-console-ia.md rule 7). When the route cannot tell
 * whether the change was recorded, the state is read again and the person
 * is told to check it; nothing is sent a second time.
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
  const router = useRouter();
  const [pending, setPending] = useState<DmSwitchChange | null>(null);
  const [notice, setNotice] = useState<DmSwitchNotice>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);

  const change = async (next: DmSwitchChange) => {
    setPending(next);
    setNotice(null);
    setFailure(null);
    try {
      const response = await adminFetch(SWITCH_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: next.scope, value: next.value }),
      });
      if (response.ok) {
        setNotice("saved");
        router.refresh();
        return;
      }
      if (response.status === 503 || response.status === 400) {
        const body = (await response.clone().json().catch(() => null)) as { error?: unknown } | null;
        if (body?.error === "outcome_unknown") {
          setNotice("outcome_unknown");
          router.refresh();
          return;
        }
        if (body?.error === "invalid_change") {
          setNotice("invalid_change");
          return;
        }
      }
      setFailure(await readAdminApiFailure(response, { fallback: m.changeFailed, locale }));
    } catch {
      // No answer: the request may have reached the route and committed, so
      // this is an unknown outcome too. Read the state again, send nothing.
      setNotice("outcome_unknown");
      setFailure(adminNetworkFailure(locale));
      router.refresh();
    } finally {
      setPending(null);
    }
  };

  return (
    <AmuxDecisionMakerSwitchView
      m={m}
      state={state}
      canChange={canChange}
      pending={pending}
      notice={notice}
      failure={failure}
      onChange={change}
    />
  );
}
