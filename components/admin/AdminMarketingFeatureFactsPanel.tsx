"use client";

import { useState } from "react";
import { Loader2, Plus, Sparkles } from "lucide-react";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminNetworkFailure, readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminMarketingFeatureFactsMessages } from "@/lib/adminMessages/marketingFeatureFacts";
import type { MarketingFeatureProposal } from "@/lib/marketingFeatureFactsCore";

/** One row as the page serialises it (lib/marketingFeatureFacts.ts). */
export type MarketingFeatureFactView = {
  id: string;
  position: number;
  what: string;
  models: string[];
  realExample: unknown;
  copy: string | null;
  disclosure: unknown;
  source: string;
  hold: string | null;
  updatedAt: string;
};

type Draft = {
  mode: "create" | "update";
  id: string;
  what: string;
  models: string;
  copy: string;
  source: string;
  hold: string;
  expectedUpdatedAt?: string;
};

const RETURN_TO = "/admin/marketing?tab=settings&view=features";

const draftOf = (row: MarketingFeatureFactView, hold = row.hold ?? ""): Draft => ({
  mode: "update",
  id: row.id,
  what: row.what,
  models: row.models.join(", "),
  copy: row.copy ?? "",
  source: row.source,
  hold,
  expectedUpdatedAt: row.updatedAt,
});

const fieldClass =
  "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none";
const buttonClass =
  "inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[13px] font-semibold text-zinc-100 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Admin › Marketing › Settings › Ad facts: the list the box's Higgsfield ad
 * job reads. Saves go through PATCH/POST /api/admin/marketing/feature-facts
 * (audited). The refresh only proposes: a proposal opens in the same form and
 * is stored only when the operator saves it.
 */
export function AdminMarketingFeatureFactsPanel({
  initial,
  canWrite,
  refreshModelId,
}: {
  initial: MarketingFeatureFactView[] | null;
  canWrite: boolean;
  refreshModelId: string | null;
}) {
  const m = useAdminMessages(adminMarketingFeatureFactsMessages);
  const { locale } = useAdminLocale();
  const [rows, setRows] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState<{ proposals: MarketingFeatureProposal[]; dropped: number } | null>(null);

  const send = async (path: string, method: "POST" | "PATCH", body?: unknown, timeoutMs?: number) => {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const response = await adminFetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      if (!response.ok) {
        setFailure(await readAdminApiFailure(response, { fallback: m.failed, locale }));
        return null;
      }
      return ((await response.json()) as { result: unknown }).result;
    } catch {
      setFailure(adminNetworkFailure(locale));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const save = async (value: Draft) => {
    const body = {
      id: value.id.trim(),
      what: value.what,
      models: value.models.split(",").map((name) => name.trim()).filter(Boolean),
      copy: value.copy,
      source: value.source,
      hold: value.hold,
      ...(value.mode === "update" ? { expectedUpdatedAt: value.expectedUpdatedAt } : {}),
    };
    const saved = (await send("/api/admin/marketing/feature-facts", value.mode === "create" ? "POST" : "PATCH", body)) as
      | (Omit<MarketingFeatureFactView, "updatedAt"> & { updatedAt: string })
      | null;
    if (!saved) return;
    setRows((current) => {
      const list = current ?? [];
      return list.some((row) => row.id === saved.id) ? list.map((row) => (row.id === saved.id ? saved : row)) : [...list, saved];
    });
    setRefresh((current) => current && { ...current, proposals: current.proposals.filter((p) => p.id !== saved.id) });
    setDraft(null);
    setNotice(m.saved);
  };

  const runRefresh = async () => {
    const result = (await send("/api/admin/marketing-feature-refresh", "POST", undefined, 150_000)) as {
      proposals: MarketingFeatureProposal[];
      dropped: number;
    } | null;
    if (result) setRefresh(result);
  };

  const openProposal = (proposal: MarketingFeatureProposal) => {
    const existing = rows?.find((row) => row.id === proposal.id);
    setDraft({
      mode: existing ? "update" : "create",
      id: proposal.id,
      what: proposal.what,
      models: proposal.models.join(", "),
      copy: proposal.copy ?? "",
      source: proposal.source,
      hold: proposal.hold ?? "",
      expectedUpdatedAt: existing?.updatedAt,
    });
  };

  const form = (value: Draft) => (
    <form
      data-testid="feature-fact-form"
      className="mt-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save(value);
      }}
    >
      {value.mode === "create" ? (
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {m.id}
          <input className={fieldClass} value={value.id} onChange={(e) => setDraft({ ...value, id: e.target.value })} required />
        </label>
      ) : null}
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        {m.what}
        <textarea className={fieldClass} rows={3} value={value.what} onChange={(e) => setDraft({ ...value, what: e.target.value })} required />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        {m.models}
        <input className={fieldClass} value={value.models} onChange={(e) => setDraft({ ...value, models: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        {m.source}
        <input className={fieldClass} value={value.source} onChange={(e) => setDraft({ ...value, source: e.target.value })} required />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        {m.copy}
        <textarea className={fieldClass} rows={2} value={value.copy} onChange={(e) => setDraft({ ...value, copy: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        {m.hold}
        <textarea className={fieldClass} rows={2} value={value.hold} onChange={(e) => setDraft({ ...value, hold: e.target.value })} />
      </label>
      <div className="flex gap-2">
        <button type="submit" className={buttonClass} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {m.save}
        </button>
        <button type="button" className={buttonClass} onClick={() => setDraft(null)} disabled={busy}>
          {m.cancel}
        </button>
      </div>
    </form>
  );

  return (
    <section data-testid="marketing-feature-facts" className="flex min-w-0 flex-col gap-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-white">{m.title}</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-400">{m.description}</p>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => setDraft({ mode: "create", id: "", what: "", models: "", copy: "", source: "", hold: "" })}
            >
              <Plus className="h-4 w-4" />
              {m.add}
            </button>
            <button type="button" data-testid="feature-facts-refresh" className={buttonClass} disabled={busy || !refreshModelId} onClick={() => void runRefresh()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {m.refresh}
            </button>
          </div>
        ) : null}
      </div>
      {canWrite ? (
        <p className="text-xs text-zinc-500">{refreshModelId ? m.refreshNote(refreshModelId) : m.refreshOff}</p>
      ) : (
        <p className="text-xs text-zinc-500">{m.readOnly}</p>
      )}
      {failure ? <AdminApiFailureNotice failure={failure} returnTo={RETURN_TO} /> : null}
      {notice ? <p role="status" className="text-xs text-emerald-300">{notice}</p> : null}
      {draft?.mode === "create" && !rows?.some((row) => row.id === draft.id) ? form(draft) : null}

      {refresh ? (
        <div data-testid="feature-facts-proposals" className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
          <h4 className="text-sm font-semibold text-violet-100">{m.proposals}</h4>
          {refresh.proposals.length === 0 ? <p className="mt-2 text-xs text-zinc-400">{m.noProposals}</p> : null}
          {refresh.dropped > 0 ? <p className="mt-2 text-xs text-zinc-500">{m.dropped(refresh.dropped)}</p> : null}
          <ul className="mt-2 flex flex-col gap-2">
            {refresh.proposals.map((proposal) => (
              <li key={proposal.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-sm">
                <p className="font-semibold text-zinc-100">
                  {m.kind[proposal.kind]} · {proposal.id}
                </p>
                <p className="mt-1 text-xs text-zinc-300">{proposal.what}</p>
                <p className="mt-1 text-xs text-zinc-500">{proposal.reason}</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => openProposal(proposal)}>
                    {m.review}
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => setRefresh({ ...refresh, proposals: refresh.proposals.filter((p) => p.id !== proposal.id) })}
                  >
                    {m.dismiss}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {rows === null ? (
        <p className="text-sm text-zinc-400">{m.unavailable}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.id} data-testid={`feature-fact-${row.id}`} className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                  {row.id}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      row.hold ? "bg-amber-500/15 text-amber-200" : "bg-emerald-500/15 text-emerald-200"
                    }`}
                  >
                    {row.hold ? m.held : m.live}
                  </span>
                </p>
                {canWrite && draft?.id !== row.id ? (
                  <div className="flex gap-2">
                    <button type="button" className={buttonClass} disabled={busy} onClick={() => setDraft(draftOf(row))}>
                      {m.edit}
                    </button>
                    {row.hold ? (
                      <button type="button" className={buttonClass} disabled={busy} onClick={() => void save(draftOf(row, ""))}>
                        {m.holdOff}
                      </button>
                    ) : (
                      <button type="button" className={buttonClass} disabled={busy} onClick={() => setDraft(draftOf(row, m.holdDefault))}>
                        {m.holdOn}
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
              {draft?.id === row.id ? (
                form(draft)
              ) : (
                <dl className="mt-2 grid gap-1 text-xs leading-5">
                  <dd className="text-zinc-200">{row.what}</dd>
                  {row.models.length > 0 ? <dd className="text-zinc-400">{row.models.join(" · ")}</dd> : null}
                  <dd className="text-zinc-500">{row.source}</dd>
                  {row.copy ? <dd className="text-zinc-400">{row.copy}</dd> : null}
                  {row.hold ? <dd className="text-amber-200/80">{row.hold}</dd> : null}
                  {row.disclosure != null ? (
                    <dd className="text-zinc-500">
                      {m.disclosure}: {(row.disclosure as { en?: string }).en ?? JSON.stringify(row.disclosure)}
                    </dd>
                  ) : null}
                  {row.realExample != null ? (
                    <dd className="text-zinc-500">
                      {m.realExample}: {String((row.realExample as { question?: string }).question ?? "")}
                    </dd>
                  ) : null}
                </dl>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
