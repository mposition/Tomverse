"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Check, Loader2, Pause } from "lucide-react";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { adminFetch } from "@/lib/adminFetch";

/**
 * The controls beside a Marketing row, and the one request path behind them.
 *
 * Every marketing mutation goes through `runMarketingAdminMutation()` on the
 * server, and they all answer the same way: `{ ok, result }`, or an `error`
 * with a `code`. So they get one caller here too. A per-control fetch would be
 * a per-control decision about what a 409 means, and the codes are the store's
 * -- transcribing them into each button is how the route layer ended up with
 * three misspelled ones before it was made to share a table.
 *
 * Nothing here decides whether an action is allowed. The switches, the kill
 * switch, the step-up window and the row's own state are all judged on the
 * server; this only declines to draw a control for a row that plainly cannot
 * take it, so the operator is not offered a button whose only outcome is 409.
 */

export type MarketingRow = Record<string, unknown>;

type FieldKind =
  | "text"
  | "textarea"
  | "datetime"
  | "url"
  | "number"
  | "select"
  | "checkbox";

/** What a ticked box sends. */
export const MARKETING_CHECKED = "yes";

export type MarketingActionField = {
  name: string;
  label: string;
  kind: FieldKind;
  /** Prefilled from the row, so the common answer is already typed in. */
  initial?: string;
  hint?: string;
  /** Required for `select`, and the only values it will offer. */
  options?: readonly string[];
};

export type MarketingAction = {
  /** Stable, and the `data-testid` suffix. */
  id: string;
  label: string;
  path: string;
  /**
   * The method the route actually exports.
   *
   * Not always POST: the settings route is a PATCH, and sending POST to it
   * answered 405 -- which reached the operator as the generic failure line,
   * so three switch toggles looked broken rather than misaddressed.
   */
  method?: "POST" | "PATCH";
  /**
   * Why this cannot be done yet, when that is a fact rather than a refusal.
   *
   * A control the server is certain to refuse is not a control. Turning
   * publishing on is the case: the publisher capability arrives in S2c, so the
   * writer answers `publisher_capability_unavailable` every time. It is drawn
   * disabled with this sentence instead of being hidden, because an operator
   * looking for the switch should find out why rather than find nothing.
   */
  unavailable?: string;
  /** Turns a successful result into a sentence, when the result says something. */
  describe?: (result: unknown) => string | null;
  /** Said before the request, not after: this is the last chance to stop. */
  confirm?: string;
  danger?: boolean;
  /** The row's main decision (approve, confirm): drawn as the one filled button. */
  primary?: boolean;
  /** An icon before the label. */
  icon?: "check" | "pause" | "arrow";
  /** Drawn at the far end of the rail, apart from the row's decisions. */
  align?: "end";
  /** For the `switch` appearance: whether the switch is on. */
  checked?: boolean;
  fields?: MarketingActionField[];
  body: (values: Record<string, string>) => unknown;
};

type Failure = {
  message: string;
  requiresReauthentication: boolean;
};

const localDateTimeValue = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  // `datetime-local` has no zone, and the browser reads what is in it as
  // local wall-clock time. Slicing the ISO string handed it the UTC hour and
  // the browser read that as local, so in UTC+10 a seven-day default was
  // stored as six days and fourteen hours -- a shorter approval window than
  // the one shown, which is the direction that silently expires things.
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

/** What the operator typed, as the instant they meant. */
export const instantFromLocalInput = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

export { localDateTimeValue };

export function MarketingActionRail({
  actions,
  section,
  onDone,
  m,
  appearance = "rail",
}: {
  actions: MarketingAction[];
  /**
   * `rail` is a row of buttons under a divider. `switch` draws each action as
   * an on/off switch (`checked`) with no divider, for a settings row. `block`
   * draws one full-width button with no divider, for a card's single control.
   * All three send, confirm and refuse the same way.
   */
  appearance?: "rail" | "switch" | "block";
  /**
   * The tab this rail is on.
   *
   * The step-up callback is built from it rather than from `usePathname()`,
   * which drops the query: re-authenticating from the accounts tab used to
   * land the operator back on the queue, having lost the row they were acting
   * on. docs/ui-contracts/admin-console-ia.md rule 2 -- the section lives in
   * `?tab=`, so a link that omits it is a link to a different screen.
   */
  section: string;
  onDone: () => void;
  m: Record<string, string>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const byId = useMemo(
    () => new Map(actions.map((action) => [action.id, action])),
    [actions]
  );

  const send = useCallback(
    async (action: MarketingAction, payload: unknown) => {
      setBusy(action.id);
      setFailure(null);
      setDone(null);
      try {
        const response = await adminFetch(action.path, {
          method: action.method ?? "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          cache: "no-store",
        });
        if (!response.ok) {
          let code: string | null = null;
          let message: string | null = null;
          try {
            const problem = (await response.json()) as {
              error?: unknown;
              code?: unknown;
            };
            code = typeof problem.code === "string" ? problem.code : null;
            message = typeof problem.error === "string" ? problem.error : null;
          } catch {
            // A body that is not JSON is still a body, and `/api/*` answers
            // `private, no-store` -- an unconsumed one never reaches
            // `requestfinished` (lib/discardResponseBody.ts).
            await discardResponseBody(response);
          }
          setFailure({
            message: message ?? m.actionFailed,
            requiresReauthentication: code === "ADMIN_REAUTHENTICATION_REQUIRED",
          });
          return;
        }
        // Read rather than discarded: the drain's answer is `remaining`, and
        // an operator told only "done" would have to discover the rest of the
        // backlog by watching the resume refuse again.
        let described: string | null = null;
        try {
          const payload = (await response.json()) as { result?: unknown };
          described = action.describe ? action.describe(payload.result) : null;
        } catch {
          await discardResponseBody(response);
        }
        setOpen(null);
        setValues({});
        setDone(described ?? m.actionDone);
        onDone();
      } catch {
        setFailure({ message: m.actionFailed, requiresReauthentication: false });
      } finally {
        setBusy(null);
      }
    },
    [m.actionDone, m.actionFailed, onDone]
  );

  const start = useCallback(
    (action: MarketingAction) => {
      if (action.unavailable) return;
      if (action.fields && action.fields.length > 0) {
        if (open === action.id) {
          setOpen(null);
          return;
        }
        setOpen(action.id);
        setFailure(null);
        setDone(null);
        setValues(
          Object.fromEntries(
            action.fields.map((field) => [field.name, field.initial ?? ""])
          )
        );
        return;
      }
      if (action.confirm && !window.confirm(action.confirm)) return;
      void send(action, action.body({}));
    },
    [open, send]
  );

  if (actions.length === 0) return null;
  const opened = open ? byId.get(open) : null;

  const ICONS = { check: Check, pause: Pause, arrow: ArrowRight } as const;
  const button = (action: MarketingAction) => {
    const Icon = action.icon ? ICONS[action.icon] : null;
    const common = {
      type: "button" as const,
      "data-testid": `marketing-action-${action.id}`,
      onClick: () => start(action),
      disabled: busy !== null || action.unavailable !== undefined,
      title: action.unavailable ?? (appearance === "switch" ? action.label : undefined),
      "aria-describedby": action.unavailable ? `marketing-why-${action.id}` : undefined,
      "aria-expanded": action.fields && !action.unavailable ? open === action.id : undefined,
    };
    if (appearance === "switch") {
      // A switch, not a button that says "turn on": its position is the state
      // and pressing it is the change. The label names the change for a screen
      // reader; the confirmation and the step-up refusal are the rail's own.
      return (
        <button
          key={action.id}
          {...common}
          role="switch"
          aria-checked={action.checked === true}
          aria-label={action.label}
          className={`relative inline-flex h-11 w-12 shrink-0 cursor-pointer items-center justify-center disabled:cursor-not-allowed disabled:opacity-50`}
        >
          <span
            className={`flex h-6 w-11 items-center rounded-full p-0.5 transition ${
              action.checked ? "justify-end bg-blue-600" : "justify-start bg-zinc-700"
            }`}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full shadow-sm ${
                action.checked ? "bg-white" : "bg-zinc-300"
              }`}
            >
              {busy === action.id ? <Loader2 className="h-3 w-3 animate-spin text-zinc-500" /> : null}
            </span>
          </span>
        </button>
      );
    }
    return (
      <button
        key={action.id}
        {...common}
        className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-[13px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
          appearance === "block" ? "w-full " : ""
        }${
          action.primary
            ? "border-blue-600 bg-blue-600 text-white hover:bg-blue-500"
            : action.danger
              ? "border-transparent text-red-300 hover:bg-red-500/10"
              : action.align === "end"
                ? "border-transparent text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                : "border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
        }`}
      >
        {busy === action.id ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className="h-4 w-4" /> : null}
        {action.label}
      </button>
    );
  };
  const leading = actions.filter((action) => action.align !== "end");
  const trailing = actions.filter((action) => action.align === "end");

  return (
    <div className={appearance === "rail" ? "mt-4 border-t border-zinc-800 pt-4" : ""}>
      <div className={appearance === "switch" ? "flex" : "flex flex-wrap items-center justify-between gap-2"}>
        {appearance === "switch" ? (
          actions.map(button)
        ) : (
          <>
            <div className={`flex flex-wrap gap-2 ${appearance === "block" ? "w-full" : ""}`}>{leading.map(button)}</div>
            {trailing.length > 0 ? <div className="flex flex-wrap gap-2">{trailing.map(button)}</div> : null}
          </>
        )}
      </div>
      {/*
        A switch row says why in its own description, under the id this list
        would have used, so the reason sits beside the label it explains.
      */}
      {appearance !== "switch" && actions.some((action) => action.unavailable) ? (
        <ul className="mt-2 grid gap-1">
          {actions
            .filter((action) => action.unavailable)
            .map((action) => (
              <li
                key={action.id}
                id={`marketing-why-${action.id}`}
                className="text-xs text-zinc-500"
              >
                {action.label}: {action.unavailable}
              </li>
            ))}
        </ul>
      ) : null}

      {opened ? (
        <form
          data-testid={`marketing-form-${opened.id}`}
          className="mt-3 grid gap-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            // Asked here as well as on a plain button. An action with fields
            // opens this form instead of sending, and the question used to be
            // skipped on that path -- so an action whose warning was the whole
            // point (arming a deliberate 503) sent without it.
            if (opened.confirm && !window.confirm(opened.confirm)) return;
            void send(opened, opened.body(values));
          }}
        >
          {(opened.fields ?? []).map((field) => (
            <label key={field.name} className="grid gap-1">
              <span className="text-xs font-medium text-zinc-400">
                {field.label}
              </span>
              {field.kind === "checkbox" ? (
                <span className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={values[field.name] === MARKETING_CHECKED}
                    onChange={(event) =>
                      setValues((previous) => ({
                        ...previous,
                        [field.name]: event.target.checked ? MARKETING_CHECKED : "",
                      }))
                    }
                    className="mt-1 h-4 w-4"
                  />
                  <span className="text-sm text-zinc-300">{field.hint}</span>
                </span>
              ) : field.kind === "select" ? (
                <select
                  value={values[field.name] ?? ""}
                  onChange={(event) =>
                    setValues((previous) => ({
                      ...previous,
                      [field.name]: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
                >
                  <option value="">{m.actionChoose}</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : field.kind === "textarea" ? (
                <textarea
                  value={values[field.name] ?? ""}
                  onChange={(event) =>
                    setValues((previous) => ({
                      ...previous,
                      [field.name]: event.target.value,
                    }))
                  }
                  rows={6}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
                />
              ) : (
                <input
                  type={
                    field.kind === "datetime"
                      ? "datetime-local"
                      : field.kind === "url"
                        ? "url"
                        : field.kind === "number"
                          ? "number"
                          : "text"
                  }
                  value={values[field.name] ?? ""}
                  onChange={(event) =>
                    setValues((previous) => ({
                      ...previous,
                      [field.name]: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
                />
              )}
              {field.hint && field.kind !== "checkbox" ? (
                <span className="text-xs text-zinc-500">{field.hint}</span>
              ) : null}
            </label>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              data-testid={`marketing-submit-${opened.id}`}
              disabled={busy !== null}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-blue-600 bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {opened.label}
            </button>
            <button
              type="button"
              onClick={() => setOpen(null)}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-zinc-700 px-3.5 py-2 text-[13px] font-semibold text-zinc-300 transition hover:bg-zinc-800"
            >
              {m.actionCancel}
            </button>
          </div>
        </form>
      ) : null}

      {done ? (
        <p
          role="status"
          aria-live="polite"
          data-testid="marketing-action-done"
          className="mt-2 text-xs font-bold text-emerald-300"
        >
          {done}
        </p>
      ) : null}

      {failure ? (
        <div
          role="alert"
          aria-live="assertive"
          data-testid="marketing-action-error"
          className="mt-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs font-bold text-red-100"
        >
          <p>{failure.message}</p>
          {failure.requiresReauthentication ? (
            <Link
              // The step-up URL, not the console-session one: the console
              // session is still valid, and this returns the operator to this
              // screen once the sign-in is recent again. A message naming the
              // remedy with no way to reach it is what
              // docs/ui-contracts/admin-console-ia.md calls a defect.
              href={adminRecentAuthenticationHref(
                `${pathname}?tab=${encodeURIComponent(section)}`
              )}
              data-testid="marketing-reauthenticate-link"
              className="mt-2 inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-red-400/50 px-2.5 py-1.5 font-bold text-red-50 underline-offset-4 transition hover:bg-red-500/20 hover:underline"
            >
              {m.signInAgain}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
