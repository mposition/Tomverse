"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { discardResponseBody } from "@/lib/discardResponseBody";

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
  /** Said before the request, not after: this is the last chance to stop. */
  confirm?: string;
  danger?: boolean;
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
  // `datetime-local` wants no zone and no seconds.
  return date.toISOString().slice(0, 16);
};

/** What the operator typed, as the instant they meant. */
export const instantFromLocalInput = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

export { localDateTimeValue };

export function MarketingActionRail({
  actions,
  onDone,
  m,
}: {
  actions: MarketingAction[];
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
        const response = await fetch(action.path, {
          method: "POST",
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
        await discardResponseBody(response);
        setOpen(null);
        setValues({});
        setDone(action.id);
        onDone();
      } catch {
        setFailure({ message: m.actionFailed, requiresReauthentication: false });
      } finally {
        setBusy(null);
      }
    },
    [m.actionFailed, onDone]
  );

  const start = useCallback(
    (action: MarketingAction) => {
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

  return (
    <div className="mt-3 border-t border-zinc-800 pt-3">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            data-testid={`marketing-action-${action.id}`}
            onClick={() => start(action)}
            disabled={busy !== null}
            aria-expanded={action.fields ? open === action.id : undefined}
            className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-60 ${
              action.danger
                ? "border-red-500/40 text-red-200 hover:bg-red-500/10"
                : "border-zinc-700 text-zinc-200 hover:bg-zinc-800"
            }`}
          >
            {busy === action.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {action.label}
          </button>
        ))}
      </div>

      {opened ? (
        <form
          data-testid={`marketing-form-${opened.id}`}
          className="mt-3 grid gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send(opened, opened.body(values));
          }}
        >
          {(opened.fields ?? []).map((field) => (
            <label key={field.name} className="grid gap-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">
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
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-100"
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
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-100"
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
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-100"
                />
              )}
              {field.hint && field.kind !== "checkbox" ? (
                <span className="text-[11px] text-zinc-500">{field.hint}</span>
              ) : null}
            </label>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              data-testid={`marketing-submit-${opened.id}`}
              disabled={busy !== null}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-xl border border-zinc-600 bg-zinc-800 px-3 py-2 text-xs font-bold text-zinc-100 transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {opened.label}
            </button>
            <button
              type="button"
              onClick={() => setOpen(null)}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-xl border border-zinc-800 px-3 py-2 text-xs font-bold text-zinc-400 transition hover:bg-zinc-800"
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
          {m.actionDone}
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
              href={adminRecentAuthenticationHref(pathname)}
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
