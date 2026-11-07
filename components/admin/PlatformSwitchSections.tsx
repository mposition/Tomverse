"use client";

import type { LucideIcon } from "lucide-react";
import { Power, ShieldCheck } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminToggleSwitch } from "@/components/admin/ui/AdminToggleSwitch";
import { adminPlatformSettingsMessages } from "@/lib/adminMessages/platformSettings";

/**
 * The two switch sections of Feature flags, drawn from values the panel owns.
 *
 * They only draw. State, the save, its step-up and its audit stay in
 * `PlatformSettingsPanel`; a switch here calls the setter it is given.
 */

export type EmergencyStopItem = {
  id: string;
  icon: LucideIcon;
  label: string;
  detail: string;
  enabled: boolean;
  onChange: (next: boolean) => void;
};

export type FeatureSwitchItem = {
  testId: string;
  label: string;
  detail: string;
  enabled: boolean;
  onChange: (next: boolean) => void;
  /** On, but held back by another switch (knowledge needs profiles). */
  waiting?: boolean;
};

/** Emergency stops: a red zone, one card per stop, each with its state in words. */
export function EmergencyStopsSection({ items }: { items: readonly EmergencyStopItem[] }) {
  const m = useAdminMessages(adminPlatformSettingsMessages);
  return (
    <section
      data-testid="admin-emergency-stops"
      aria-labelledby="admin-emergency-title"
      className="flex min-w-0 flex-col gap-4 rounded-2xl border-2 border-red-500/40 bg-red-500/5 p-5"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-red-500/15 text-red-300">
          <Power className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id="admin-emergency-title" className="text-base font-bold text-white">
            {m.stops.title}
          </h2>
          <p className="mt-0.5 text-sm text-zinc-400">{m.stops.description}</p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((stop) => {
          const Icon = stop.icon;
          return (
            <div
              key={stop.id}
              data-testid={"admin-kill-switch-" + stop.id}
              data-enabled={stop.enabled ? "true" : "false"}
              className="flex min-w-0 items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-200">
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-white">{stop.label}</p>
                <p className="truncate text-xs text-zinc-500">{stop.detail}</p>
                <AdminStatusChip tone={stop.enabled ? "ok" : "bad"} className="mt-2">
                  {stop.enabled ? m.stops.running : m.stops.stopped}
                </AdminStatusChip>
              </div>
              <AdminToggleSwitch
                checked={stop.enabled}
                onChange={stop.onChange}
                label={stop.label}
                data-testid={"admin-kill-switch-" + stop.id + "-toggle"}
              />
            </div>
          );
        })}
      </div>
      <p className="text-xs text-zinc-500">{m.stops.cleanupNote}</p>
    </section>
  );
}

/** Feature switches: who it is on for, as a chip, and the switch. */
export function FeatureSwitchesSection({ items }: { items: readonly FeatureSwitchItem[] }) {
  const m = useAdminMessages(adminPlatformSettingsMessages);
  const notes: ReadonlyArray<readonly [string, string]> = [
    [m.chatStarter.title, m.chatStarter.description],
    [m.imageGeneration.title, m.imageGeneration.description],
    [m.externalImport.title, m.externalImport.description],
    [
      m.externalImport.continuationToggle,
      m.externalImport.continuationBefore +
        m.externalImport.continuationSeparate +
        m.externalImport.continuationAfter,
    ],
    [m.assistantProfiles.title, m.assistantProfiles.description],
  ];
  return (
    <AdminTile
      data-testid="admin-feature-switches"
      title={m.switches.title}
      description={m.switches.description}
    >
      <p className="flex items-start gap-2 rounded-xl bg-blue-500/10 p-3 text-xs text-blue-200">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {m.switches.humanOff}
      </p>
      <ul className="flex flex-col">
        {items.map((flag) => (
          <li
            key={flag.testId}
            className="flex flex-wrap items-center gap-3 border-t border-zinc-800 py-3 first:border-t-0"
          >
            <div className="min-w-0 flex-1 basis-56">
              <p className="text-sm font-bold text-white">{flag.label}</p>
              <p className="text-xs text-zinc-500">{flag.detail}</p>
              {flag.waiting ? (
                <p className="mt-1 text-xs font-bold text-amber-300">
                  {m.assistantProfiles.knowledgeStaysOff}
                </p>
              ) : null}
            </div>
            <AdminStatusChip tone={flag.waiting ? "warn" : flag.enabled ? "ok" : "idle"}>
              {flag.waiting
                ? m.switches.waitsForProfiles
                : flag.enabled
                  ? m.switches.onForEveryone
                  : m.switches.off}
            </AdminStatusChip>
            <AdminToggleSwitch
              checked={flag.enabled}
              onChange={flag.onChange}
              label={flag.label}
              data-testid={flag.testId}
            />
          </li>
        ))}
      </ul>
      <p className="text-xs text-zinc-500">{m.switches.saveNote}</p>
      <AdminTechInfo summary={m.switches.details}>
        <dl className="flex flex-col gap-3 font-sans">
          {notes.map(([title, body]) => (
            <div key={title}>
              <dt className="font-bold text-zinc-200">{title}</dt>
              <dd className="mt-0.5 leading-5">{body}</dd>
            </div>
          ))}
        </dl>
      </AdminTechInfo>
    </AdminTile>
  );
}
