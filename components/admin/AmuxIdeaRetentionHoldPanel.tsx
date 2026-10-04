"use client";

import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxRetentionHoldMessages } from
  "@/lib/adminMessages/amuxRetentionHold";
import { adminRecentAuthenticationHref } from
  "@/lib/adminReauthenticationCore";

type Reason = "legal_request" | "dispute" | "incident" | "other";
type Hold = { id: string; reasonCode: Reason; expiresAt: string;
  releasedAt: string | null; noticeSentAt: string | null;
  approvalAuditLogId: string };
type View = { checkedAt: string; scope: { remainingBodies: number;
  alreadyPurgedBodies: number }; holds: Hold[] };

const ENDPOINT = "/api/admin/amux/ideas/retention-holds";

function validView(value: unknown): value is View {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<View>;
  return typeof row.checkedAt === "string" &&
    Number.isFinite(Date.parse(row.checkedAt)) &&
    !!row.scope && Number.isSafeInteger(row.scope.remainingBodies) &&
    Number.isSafeInteger(row.scope.alreadyPurgedBodies) &&
    Array.isArray(row.holds) && row.holds.every((hold) =>
      typeof hold?.id === "string" && typeof hold.expiresAt === "string" &&
      typeof hold.approvalAuditLogId === "string");
}

export function AmuxIdeaRetentionHoldPanel({ ideaId }: { ideaId: string }) {
  const m = useAdminMessages(adminAmuxRetentionHoldMessages);
  const [view, setView] = useState<View | null>(null);
  const [reasonCode, setReasonCode] = useState<Reason>("incident");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<"unavailable" | "uncertain" | null>(null);
  const [reauth, setReauth] = useState(false);
  const active = view?.holds.find((hold) => !hold.releasedAt &&
    Date.parse(hold.expiresAt) > Date.parse(view.checkedAt));

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setReauth(false);
    try {
      const response = await adminFetch(`${ENDPOINT}?ideaId=${encodeURIComponent(ideaId)}`,
        { cache: "no-store" });
      if (response.status === 428) { setReauth(true); setView(null); return; }
      const body: unknown = await response.json();
      if (!response.ok || !validView(body)) {
        setView(null); setMessage("unavailable"); return;
      }
      setView(body);
    } catch { setView(null); setMessage("unavailable"); }
    finally { setBusy(false); }
  };

  const write = async (kind: "create" | "release") => {
    if (busy || !view) return;
    const holdId = kind === "create" ? crypto.randomUUID() : active?.id;
    if (!holdId) return;
    if (!window.confirm(kind === "create" ? m.confirmCreate : m.confirmRelease)) return;
    setBusy(true);
    setMessage(null);
    setReauth(false);
    try {
      const response = await adminFetch(ENDPOINT, {
        method: kind === "create" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "create" ? {
          id: holdId, ideaId, reasonCode, days,
          expectedRemainingBodies: view.scope.remainingBodies,
          expectedAlreadyPurgedBodies: view.scope.alreadyPurgedBodies,
          ...(active ? { replacesHoldId: active.id } : {}),
        } : { holdId, ideaId }),
      });
      if (response.status === 428) { setReauth(true); setView(null); return; }
      // A network/HTTP failure may occur after COMMIT. Invalidate this
      // snapshot and require explicit read-back, never automatic re-POST.
      setView(null);
      setMessage(response.ok ? null : "uncertain");
    } catch { setView(null); setMessage("uncertain"); }
    finally { setBusy(false); }
  };

  return <section className="space-y-3 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800"
    aria-labelledby="amux-v4-retention-hold-heading">
    <h3 id="amux-v4-retention-hold-heading" className="font-semibold text-zinc-900 dark:text-zinc-100">
      {m.title}
    </h3>
    <p className="text-zinc-700 dark:text-zinc-300">{m.hint}</p>
    <button type="button" onClick={() => void refresh()} disabled={busy}
      className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
      {busy ? m.loading : m.load}
    </button>
    {message ? <p role="alert">{m[message]}</p> : null}
    {reauth ? <a className="underline" href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>{m.reauth}</a> : null}
    {view ? <div className="space-y-3">
      <p>{m.scope(view.scope.remainingBodies, view.scope.alreadyPurgedBodies)}</p>
      {active ? <p role="status">{m.active(active.expiresAt)}</p> : null}
      {view.holds.map((hold) => <p key={hold.id} className="text-xs text-zinc-600 dark:text-zinc-400">
        {hold.id} · {hold.releasedAt ? m.released :
          Date.parse(hold.expiresAt) <= Date.parse(view.checkedAt) ?
            m.expired : m.active(hold.expiresAt)}
        {hold.noticeSentAt ? ` · ${m.notice}` : ""}
      </p>)}
      {view.scope.remainingBodies > 0 ? <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">{m.reason}
          <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value as Reason)}
            disabled={busy} className="min-h-11 rounded-lg border border-zinc-300 px-3 dark:border-zinc-700 dark:bg-zinc-900">
            {(Object.keys(m.reasons) as Reason[]).map((reason) =>
              <option key={reason} value={reason}>{m.reasons[reason]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">{m.days}
          <input type="number" min={1} max={90} value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            className="min-h-11 w-24 rounded-lg border border-zinc-300 px-3 dark:border-zinc-700 dark:bg-zinc-900" />
        </label>
        <button type="button" onClick={() => void write("create")}
          disabled={busy || !Number.isInteger(days) || days < 1 || days > 90}
          className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
          {active ? m.renew : m.create}
        </button>
      </div> : null}
      {active ? <button type="button" onClick={() => void write("release")}
        disabled={busy} className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
        {m.release}
      </button> : null}
    </div> : null}
  </section>;
}
