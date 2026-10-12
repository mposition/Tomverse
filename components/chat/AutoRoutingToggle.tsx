"use client";

import { Sparkles } from "lucide-react";

import {
  autoRoutingCopy,
  type AutoRoutingLanguage,
} from "@/lib/autoRoutingCopy";

/**
 * The Auto switch, at the top of the model picker.
 *
 * Renders nothing at all when the account would not be routed. That is the
 * whole contract: `offered` already folds together the feature flag and cohort
 * eligibility (`lib/autoRoutingUi.ts`), so a disabled-but-visible control
 * never exists. A greyed-out Auto row would raise exactly the question the
 * rollout cannot answer -- "why not me?" -- and the honest answer is internal
 * rollout state nobody outside the team should be reading.
 *
 * ## Why it is a switch and not a model row
 *
 * Auto is not a model. Putting it in the catalogue beside real models would
 * make "Auto" look like something with a context window, a price and a
 * provider, and the credit estimate under the picker would have nothing to
 * show for it. It sits above the list, as a mode.
 *
 * While Auto is on the model list stays visible and stays selectable: turning
 * Auto off has to return the conversation to a model the user recognises, and
 * hiding what that would be makes the switch feel like a door with no handle
 * on the other side.
 *
 * The on state uses the approved `status-switch-on-*` role. The state is also
 * carried by `aria-checked` and the knob position, so colour is never the only
 * signal.
 */
export function AutoRoutingToggle({
  offered,
  enabled,
  pending,
  language,
  onChange,
}: {
  /** From the server's `autoSelection.offered`. False renders nothing. */
  offered: boolean;
  enabled: boolean;
  /** True while a change is in flight, so the switch cannot be double-sent. */
  pending?: boolean;
  language: AutoRoutingLanguage;
  onChange: (next: boolean) => void;
}) {
  if (!offered) return null;
  const copy = autoRoutingCopy[language] ?? autoRoutingCopy.en;

  return (
    <div
      data-testid="auto-routing-toggle"
      className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-700 dark:bg-zinc-900"
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
          enabled
            ? "border-transparent bg-status-switch-on-500 text-white"
            : "border-zinc-300 text-zinc-400 dark:border-zinc-600 dark:text-zinc-500"
        }`}
      >
        <Sparkles className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {copy.label}
        </div>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {copy.description}
        </p>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={copy.label}
        disabled={pending}
        onClick={() => onChange(!enabled)}
        // The state is on aria-checked and in the knob's position, never in
        // the colour alone -- the same rule the selection badge follows.
        className="mt-0.5 flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          data-testid="auto-routing-track"
          className={`relative h-6 w-11 overflow-hidden rounded-full border transition-colors ${
            enabled
              ? "border-transparent bg-status-switch-on-500"
              : "border-zinc-300 bg-zinc-200 dark:border-zinc-600 dark:bg-zinc-700"
          }`}
        >
          <span
            data-testid="auto-routing-thumb"
            className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </span>
      </button>

      {/* Announced on change rather than on render, so a screen reader is told
          what happened instead of re-reading the control. */}
      <span className="sr-only" role="status" aria-live="polite">
        {enabled ? copy.turnedOn : copy.turnedOff}
      </span>
    </div>
  );
}

/**
 * The same server-owned Auto mode, exposed at the point where a message is
 * sent. This is deliberately its own button rather than a button nested in the
 * model-picker trigger: each control keeps one action and one accessible name.
 */
export function AutoRoutingComposerToggle({
  offered,
  enabled,
  pending,
  language,
  onChange,
}: {
  offered: boolean;
  enabled: boolean;
  pending?: boolean;
  language: AutoRoutingLanguage;
  onChange: (next: boolean) => void;
}) {
  if (!offered) return null;
  const copy = autoRoutingCopy[language] ?? autoRoutingCopy.en;

  return (
    <button
      type="button"
      role="switch"
      data-testid="composer-auto-routing-toggle"
      aria-checked={enabled}
      aria-label={copy.label}
      disabled={pending}
      onClick={() => onChange(!enabled)}
      className={`flex h-11 shrink-0 touch-manipulation items-center gap-1.5 rounded-full border px-2 text-xs font-semibold transition-colors disabled:cursor-wait disabled:opacity-50 ${
        enabled
          ? "border-status-switch-on-500 bg-status-switch-on-500 text-white"
          : "border-zinc-300 bg-zinc-50 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-800"
      }`}
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{copy.label}</span>
      <span
        aria-hidden="true"
        data-testid="composer-auto-routing-track"
        className={`relative h-5 w-9 shrink-0 overflow-hidden rounded-full border transition-colors ${
          enabled
            ? "border-white/50 bg-white/25"
            : "border-zinc-300 bg-zinc-200 dark:border-zinc-600 dark:bg-zinc-700"
        }`}
      >
        <span
          data-testid="composer-auto-routing-thumb"
          className={`absolute left-0 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
            enabled ? "translate-x-[1.125rem]" : "translate-x-1"
          }`}
        />
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {enabled ? copy.turnedOn : copy.turnedOff}
      </span>
    </button>
  );
}
