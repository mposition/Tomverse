"use client";

import Link from "next/link";
import { useState } from "react";
import { Bookmark, Star } from "lucide-react";

const views = [
  { id: "overview", label: "Launch overview", href: "/admin" },
  { id: "users", label: "Customer ops", href: "/admin?tab=users" },
  { id: "billing", label: "Billing control", href: "/admin?tab=billing" },
  { id: "refunds", label: "Refund queue", href: "/admin?tab=refunds" },
  { id: "providers", label: "Provider health", href: "/admin?tab=providers" },
  { id: "alerts", label: "Alerts and webhooks", href: "/admin?tab=alerts" },
  { id: "feedback", label: "Support inbox", href: "/admin?tab=feedback" },
] as const;

export function AdminSavedViewsPanel({ activeTab }: { activeTab: string }) {
  const [defaultView, setDefaultView] = useState(() => {
    if (typeof window === "undefined") return "overview";
    return localStorage.getItem("tomverse-admin-default-view") || "overview";
  });

  const saveDefault = (id: string) => {
    localStorage.setItem("tomverse-admin-default-view", id);
    setDefaultView(id);
  };

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Saved views
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">Operator shortcuts</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Save a preferred Admin view and jump between launch-critical workflows faster.
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-black text-zinc-300">
          <Bookmark className="h-3.5 w-3.5 text-blue-300" />
          Default: {defaultView}
        </span>
      </div>
      <div className="mt-5 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {views.map((view) => (
          <div
            key={view.id}
            className={`rounded-2xl border p-3 ${
              activeTab === view.id
                ? "border-blue-500/30 bg-blue-500/10"
                : "border-zinc-800 bg-zinc-900/70"
            }`}
          >
            <Link
              href={view.href}
              className="block cursor-pointer text-sm font-black text-white hover:text-blue-200"
            >
              {view.label}
            </Link>
            <button
              type="button"
              onClick={() => saveDefault(view.id)}
              className="mt-3 inline-flex cursor-pointer items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-xs font-black text-zinc-300 transition hover:bg-zinc-800"
            >
              <Star className={`h-3.5 w-3.5 ${defaultView === view.id ? "fill-amber-300 text-amber-300" : ""}`} />
              Set default
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
