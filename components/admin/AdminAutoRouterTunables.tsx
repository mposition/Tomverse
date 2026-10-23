"use client";

import { RotateCcw } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAutoRouterOptimizerMessages } from "@/lib/adminMessages/autoRouterOptimizer";

/** What the route returns for the optimizer's own setting changes. */
export type TunableSettingsState = {
  autoApply: boolean;
  routerTimeoutMs: { value: number; previous: number; setAt: string; cycleId: string; reason: string } | null;
  excluded: { modelId: string; until: string; setAt: string; cycleId: string; reason: string }[];
};

export type TunableAction =
  | { action: "set_setting_auto_apply"; enabled: boolean }
  | { action: "undo_router_timeout" }
  | { action: "undo_model_exclusion"; modelId: string };

/**
 * Admin › Routing: the owner's switch for the optimizer's own setting changes,
 * and every change in force with its reason and an undo. Each change was also
 * sent to the operator as a notice when it was made.
 */
export function AutoRouterTunables({
  settings,
  busy,
  send,
}: {
  settings: TunableSettingsState | undefined;
  busy: boolean;
  send: (action: TunableAction) => void;
}) {
  const m = useAdminMessages(adminAutoRouterOptimizerMessages);
  const buttonClass =
    "inline-flex min-h-11 items-center gap-1 rounded-xl border border-zinc-600 px-3 text-xs font-bold text-zinc-200 disabled:opacity-50";
  return (
    <div className="mt-5 rounded-2xl border border-zinc-800 p-4" data-testid="admin-auto-router-tunables">
      <h3 className="text-sm font-bold text-zinc-200">{m.tunablesTitle}</h3>
      <label className="mt-2 flex min-h-11 items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={settings?.autoApply === true}
          disabled={busy || !settings}
          onChange={(event) => send({ action: "set_setting_auto_apply", enabled: event.target.checked })}
          data-testid="admin-auto-router-tunables-auto-apply"
          className="h-5 w-5"
        />
        <span>
          <span className="font-bold">{m.tunablesAutoApply}</span>
          <span className="block text-xs text-zinc-500">{m.tunablesNote}</span>
        </span>
      </label>
      {settings && !settings.routerTimeoutMs && settings.excluded.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">{m.tunablesNone}</p>
      ) : null}
      <ul className="mt-2 space-y-2 text-xs text-zinc-300">
        {settings?.routerTimeoutMs ? (
          <li className="rounded-xl border border-zinc-800 p-3" data-testid="admin-auto-router-tunable-timeout">
            <p className="font-bold">
              {m.tunableTimeout(settings.routerTimeoutMs.previous, settings.routerTimeoutMs.value)}
            </p>
            <p className="mt-1 text-zinc-400">{settings.routerTimeoutMs.reason}</p>
            <p className="mt-1 text-zinc-500">{new Date(settings.routerTimeoutMs.setAt).toLocaleString()}</p>
            <button
              type="button"
              onClick={() => send({ action: "undo_router_timeout" })}
              disabled={busy}
              data-testid="admin-auto-router-tunable-timeout-undo"
              className={`mt-2 ${buttonClass}`}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              {m.tunableUndo}
            </button>
          </li>
        ) : null}
        {settings?.excluded.map((item) => (
          <li
            key={item.modelId}
            className="rounded-xl border border-zinc-800 p-3"
            data-testid="admin-auto-router-tunable-exclusion"
          >
            <p className="font-bold">{m.tunableExclusion(item.modelId, new Date(item.until).toLocaleString())}</p>
            <p className="mt-1 text-zinc-400">{item.reason}</p>
            <button
              type="button"
              onClick={() => send({ action: "undo_model_exclusion", modelId: item.modelId })}
              disabled={busy}
              data-testid="admin-auto-router-tunable-exclusion-undo"
              className={`mt-2 ${buttonClass}`}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              {m.tunableUndo}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
