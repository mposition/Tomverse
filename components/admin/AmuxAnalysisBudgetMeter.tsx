"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { amuxBarFraction } from "@/lib/adminAmuxFlow";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxScreensMessages } from "@/lib/adminMessages/amuxScreens";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { analysisBudgetMicroUsdToUsd, readAnalysisBudgetSnapshotReply } from "@/lib/amux/ideaAnalysisBudgetSettingCore";

const ENDPOINT = "/api/admin/amux/ideas/analysis-budget-settings";
type Snapshot = NonNullable<ReturnType<typeof readAnalysisBudgetSnapshotReply>>;
type State = { kind: "loading" } | { kind: "ready"; snapshot: Snapshot } | { kind: "reauthenticate" } | { kind: "unavailable" };

/**
 * This month's analysis budget as one line under the idea box: what is spent
 * and reserved against the limit. It only reads the existing snapshot route
 * (the budget itself is set in AMUX settings); a read that fails or needs a
 * fresh sign-in says so instead of drawing an empty bar.
 */
export function AmuxAnalysisBudgetMeter() {
  const m = useAdminMessages(adminAmuxScreensMessages).ideas.budget;
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    adminFetch(ENDPOINT, { cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 428) return setState({ kind: "reauthenticate" });
        const snapshot = response.ok ? readAnalysisBudgetSnapshotReply(await response.json()) : null;
        if (active) setState(snapshot ? { kind: "ready", snapshot } : { kind: "unavailable" });
      })
      .catch(() => {
        if (active) setState({ kind: "unavailable" });
      });
    return () => {
      active = false;
    };
  }, []);

  if (state.kind === "loading") {
    return <p role="status" className="text-xs text-zinc-500" data-testid="amux-budget-meter">{m.loading}</p>;
  }
  if (state.kind === "reauthenticate") {
    return (
      <p className="text-xs text-zinc-400" data-testid="amux-budget-meter">
        {m.reauthenticate}{" "}
        <Link className="font-medium text-blue-300 underline" href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>{m.signIn}</Link>
      </p>
    );
  }
  if (state.kind === "unavailable") {
    return <p role="alert" className="text-xs text-amber-300" data-testid="amux-budget-meter">{m.unavailable}</p>;
  }
  const { snapshot } = state;
  const committed = BigInt(snapshot.spentMicroUsd) + BigInt(snapshot.reservedMicroUsd);
  const fraction = amuxBarFraction(Number(committed), Number(snapshot.limitMicroUsd));
  const percent = fraction === null ? 0 : Math.round(fraction * 100);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400" data-testid="amux-budget-meter">
      <span>{m.label}</span>
      <span
        role="progressbar"
        aria-label={m.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 w-40 max-w-full overflow-hidden rounded-full bg-zinc-800"
      >
        <span
          className={`block h-full rounded-full ${percent >= 100 ? "bg-red-500" : percent >= 80 ? "bg-amber-500" : "bg-cyan-500"}`}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="font-medium tabular-nums text-zinc-200">
        {m.amounts(analysisBudgetMicroUsdToUsd(committed.toString()), analysisBudgetMicroUsdToUsd(snapshot.limitMicroUsd))}
      </span>
    </div>
  );
}
