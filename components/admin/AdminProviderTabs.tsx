"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Activity, ShieldAlert, SlidersHorizontal } from "lucide-react";

type ProviderSubTab = "health" | "operations" | "controls";

type Props = {
  healthContent: ReactNode;
  operationsContent: ReactNode;
  controlsContent: ReactNode;
  activeIncidentCount: number;
  blockedModelCount: number;
};

const tabs: Array<{
  id: ProviderSubTab;
  label: string;
  description: string;
  icon: typeof Activity;
}> = [
  {
    id: "health",
    label: "Provider Health",
    description: "Availability, spend, fallback notes, and model metrics",
    icon: Activity,
  },
  {
    id: "operations",
    label: "Tests / Incidents / Fallback",
    description: "Run checks, create incidents, and recover provider traffic",
    icon: ShieldAlert,
  },
  {
    id: "controls",
    label: "Model Registry",
    description: "Specifications, API configuration, credits, and live availability",
    icon: SlidersHorizontal,
  },
];

export function AdminProviderTabs({
  healthContent,
  operationsContent,
  controlsContent,
  activeIncidentCount,
  blockedModelCount,
}: Props) {
  const [activeTab, setActiveTab] = useState<ProviderSubTab>("health");

  const content =
    activeTab === "operations"
      ? operationsContent
      : activeTab === "controls"
        ? controlsContent
        : healthContent;

  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-3">
        <div className="grid gap-2 lg:grid-cols-3">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            const badge =
              tab.id === "operations"
                ? activeIncidentCount
                : tab.id === "controls"
                  ? blockedModelCount
                  : null;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 text-left transition ${
                  active
                    ? "border-blue-500/40 bg-blue-500/15 text-white"
                    : "border-zinc-800 bg-zinc-900/70 text-zinc-400 hover:border-zinc-700 hover:text-white"
                }`}
                aria-pressed={active}
              >
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                    active
                      ? "border-blue-400/40 bg-blue-500/20 text-blue-200"
                      : "border-zinc-800 bg-zinc-950 text-zinc-500"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-black">
                    {tab.label}
                    {badge !== null ? (
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-black ${
                          badge > 0
                            ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                            : "border-zinc-700 bg-zinc-950 text-zinc-500"
                        }`}
                      >
                        {badge}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-zinc-500">
                    {tab.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {content}
    </section>
  );
}
