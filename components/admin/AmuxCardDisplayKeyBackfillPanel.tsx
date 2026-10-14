"use client";

import { useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminNetworkFailure, readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxCardDisplayKeyBackfillMessages } from "@/lib/adminMessages/amuxCardDisplayKeyBackfill";

type Plan = {
  planDigest: string;
  features: Array<{ id: string; title: string | null; prefix: string; from: "title" | "fallback" }>;
  cards: Array<{ id: string; prefix: string; displayKey: string }>;
  unresolved: Array<{ id: string; reason: string }>;
};

const ENDPOINT = "/api/admin/amux/card-display-key-backfill";

function parsePlan(value: unknown): Plan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const plan = value as Record<string, unknown>;
  if (typeof plan.planDigest !== "string" || !/^[0-9a-f]{64}$/.test(plan.planDigest) ||
      !Array.isArray(plan.features) || !Array.isArray(plan.cards) || !Array.isArray(plan.unresolved)) {
    return null;
  }
  return plan as Plan;
}

/**
 * docs/policy/amux-card-display-key.md §5: the owner loads the plan, sees
 * every prefix and number it would write, and applies exactly that plan. The
 * apply names the plan's digest; the server refuses one that no longer matches.
 */
export function AmuxCardDisplayKeyBackfillPanel() {
  const m = useAdminMessages(adminAmuxCardDisplayKeyBackfillMessages);
  const { locale } = useAdminLocale();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<"load" | "apply" | null>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setBusy("load"); setFailure(null); setNotice(null);
    try {
      const response = await adminFetch(ENDPOINT, { cache: "no-store" });
      if (!response.ok) { setPlan(null); setFailure(await readAdminApiFailure(response, { fallback: m.readFailed, locale })); return; }
      const parsed = parsePlan(await response.json().catch(() => null));
      if (!parsed) { setPlan(null); setNotice(m.readFailed); return; }
      setPlan(parsed);
    } catch { setFailure(adminNetworkFailure(locale)); }
    finally { setBusy(null); }
  }

  async function apply() {
    if (!plan) return;
    setBusy("apply"); setFailure(null); setNotice(null);
    try {
      const response = await adminFetch(ENDPOINT, { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planDigest: plan.planDigest }) });
      if (response.ok) {
        const body = await response.json().catch(() => null) as { features?: number; cards?: number } | null;
        setPlan(null);
        setNotice(m.applied(body?.features ?? 0, body?.cards ?? 0));
        return;
      }
      if (response.status === 409) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        setPlan(null);
        setNotice(body?.error === "nothing_to_apply" ? m.nothingToApply : m.planChanged);
        return;
      }
      setFailure(await readAdminApiFailure(response, { fallback: m.writeFailed, locale }));
    } catch {
      // The write may have committed; never resend it blind.
      setPlan(null);
      setNotice(m.outcomeUnknown);
    } finally { setBusy(null); }
  }

  const nothing = plan !== null && plan.features.length === 0 && plan.cards.length === 0;
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-4" data-testid="amux-card-display-key-backfill">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{m.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.description}</p>
      <div>
        <button type="button" onClick={() => void load()} disabled={busy !== null}
          className="min-h-11 rounded border border-zinc-400 px-3 disabled:opacity-50">
          {busy === "load" ? m.loading : m.load}</button>
      </div>
      {failure ? <AdminApiFailureNotice failure={failure} /> : null}
      {notice ? <p role="status" className="text-sm" data-testid="amux-card-display-key-backfill-notice">{notice}</p> : null}
      {plan && nothing ? <p role="status" className="text-sm">{m.empty}</p> : null}
      {plan && !nothing ? <>
        <p className="text-sm" data-testid="amux-card-display-key-backfill-summary">
          {m.summary(plan.features.length, plan.cards.length, plan.unresolved.length)}</p>
        {plan.features.length > 0 ? <div>
          <h3 className="font-medium">{m.featuresHeading}</h3>
          <ul className="text-sm" data-testid="amux-card-display-key-backfill-features">
            {plan.features.map((feature) => <li key={feature.id}>
              <span className="font-mono">{feature.prefix}</span> · {feature.title ?? m.untitled}
              <span className="text-xs opacity-70"> ({m.featureFrom(feature.from)})</span></li>)}
          </ul></div> : null}
        {plan.cards.length > 0 ? <div>
          <h3 className="font-medium">{m.cardsHeading}</h3>
          <ul className="max-h-80 overflow-y-auto text-sm" data-testid="amux-card-display-key-backfill-cards">
            {plan.cards.map((card) => <li key={card.id}>
              <span className="font-mono">{card.displayKey}</span>
              <span className="font-mono text-xs opacity-70"> · {card.id}</span></li>)}
          </ul></div> : null}
        {plan.unresolved.length > 0 ? <div>
          <h3 className="font-medium">{m.unresolvedHeading}</h3>
          <ul className="text-sm">
            {plan.unresolved.map((item) => <li key={item.id}>
              <span className="font-mono text-xs">{item.id}</span> · {m.unresolvedReason(item.reason)}</li>)}
          </ul></div> : null}
        <p className="font-mono text-xs opacity-70">{m.digest}: {plan.planDigest}</p>
        <div>
          <button type="button" onClick={() => void apply()} disabled={busy !== null}
            className="min-h-11 rounded border border-zinc-400 px-3 font-medium disabled:opacity-50"
            data-testid="amux-card-display-key-backfill-apply">
            {busy === "apply" ? m.applying : m.apply}</button>
        </div>
      </> : null}
    </section>
  );
}
