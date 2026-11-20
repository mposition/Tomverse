"use client";

import { Check } from "lucide-react";

import type { CodingMessages } from "@/components/admin/modelCatalog/CodingListViews";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminProviderMark } from "@/components/admin/ui/AdminProviderMark";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { type CodingProviderRow, type ProviderTermsState, providerTermsComparison } from "@/lib/adminModelCatalogFlow";
import type { AdminTone } from "@/lib/adminUiCore";

// The coding tab's provider conditions (Figma 04): one row per provider, its
// LLM re-check and the comparison an operator applies it from.

const STATE_TONE: Record<ProviderTermsState, AdminTone> = { confirmed: "ok", expired: "warn", missing: "warn", invalid: "bad" };

const shortUrl = (url: string) => url.replace(/^https:\/\//, "");

const UrlLink = ({ url }: { url: string | null | undefined }) =>
  url ? (
    <a href={url} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-blue-300 underline">
      {shortUrl(url)}
    </a>
  ) : (
    <span className="text-zinc-500">—</span>
  );

export function CodingProviderTable({
  c,
  providers,
  drafting,
  openDraft,
  draftConfigured,
  onCheck,
  onOpenDraft,
}: {
  c: CodingMessages;
  providers: readonly CodingProviderRow[];
  /** The provider being drafted, if any. */
  drafting: string | null;
  /** The provider whose draft is shown below the table. */
  openDraft: string | null;
  draftConfigured: boolean;
  onCheck: (row: CodingProviderRow) => void;
  onOpenDraft: (row: CodingProviderRow) => void;
}) {
  const p = c.providers;
  const counts = {
    confirmed: providers.filter((row) => row.state === "confirmed").length,
    expired: providers.filter((row) => row.state === "expired").length,
    missing: providers.filter((row) => row.state === "missing" || row.state === "invalid").length,
  };
  const columns: AdminDataColumn<CodingProviderRow>[] = [
    {
      key: "provider",
      header: p.columns.provider,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <AdminProviderMark provider={row.provider} size={24} />
          <span className="min-w-0">
            <span className="block font-mono font-bold text-zinc-100">{row.provider}</span>
            <span className="block text-[11px] text-zinc-500">{p.counts(row.modelCount, row.candidateCount)}</span>
            {row.legacyTermsCount > 0 ? <span className="block text-[11px] text-amber-300">{p.legacy(row.legacyTermsCount)}</span> : null}
          </span>
        </span>
      ),
    },
    { key: "terms", header: p.columns.terms, render: (row) => <UrlLink url={row.terms?.termsUrl} /> },
    {
      key: "resale",
      header: p.columns.resale,
      render: (row) =>
        row.terms ? (
          <AdminStatusChip tone={row.terms.allowsResaleAndCodingAgent ? "ok" : "bad"}>
            {row.terms.allowsResaleAndCodingAgent ? p.allowed : p.denied}
          </AdminStatusChip>
        ) : (
          <AdminStatusChip tone="idle">{p.unchecked}</AdminStatusChip>
        ),
    },
    { key: "retention", header: p.columns.retention, render: (row) => <UrlLink url={row.terms?.retentionUrl} /> },
    { key: "region", header: p.columns.region, render: (row) => <span className="text-xs text-zinc-200">{row.terms?.processingRegion ?? "—"}</span> },
    { key: "checked", header: p.columns.checked, render: (row) => <span className="font-mono text-xs text-zinc-300">{row.checkedAt ?? "—"}</span> },
    {
      key: "state",
      header: p.columns.state,
      render: (row) => (
        <span className="flex flex-col items-start gap-1" data-testid="coding-provider-state" data-state={row.state}>
          <AdminStatusChip tone={STATE_TONE[row.state]}>{p.state[row.state]}</AdminStatusChip>
          {row.dueOn ? (
            <span className="text-[11px] text-zinc-500">{row.state === "expired" ? p.expiredSince(row.dueOn) : p.dueOn(row.dueOn)}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "action",
      header: p.columns.action,
      align: "right",
      render: (row) =>
        !row.draftable ? (
          <span className="text-xs text-zinc-500">{p.notDraftable}</span>
        ) : row.draft ? (
          <AdminWriteButton size="sm" variant="secondary" onClick={() => onOpenDraft(row)} data-testid="coding-provider-view-draft">
            {openDraft === row.provider ? p.viewDraft : p.draftTitle(row.provider)}
          </AdminWriteButton>
        ) : (
          <AdminWriteButton
            size="sm"
            variant="secondary"
            disabled={!draftConfigured || drafting !== null}
            onClick={() => onCheck(row)}
            data-testid="coding-provider-check"
          >
            {drafting === row.provider ? p.drafting : row.terms ? p.recheck : p.start}
          </AdminWriteButton>
        ),
    },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="coding-providers">
      <div role="note" className="rounded-2xl border border-blue-500/40 bg-blue-500/10 p-4 text-sm">
        <p className="font-bold text-blue-300">{p.bannerTitle}</p>
        <p className="mt-1 text-zinc-300">{p.bannerBody}</p>
      </div>
      <AdminTile
        title={
          <span className="flex items-center gap-2">
            {p.title}
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{providers.length}</span>
          </span>
        }
        description={p.note}
        action={
          <span className="flex flex-wrap gap-1.5">
            <AdminStatusChip tone="ok">{p.count.confirmed(counts.confirmed)}</AdminStatusChip>
            {counts.expired ? <AdminStatusChip tone="warn">{p.count.expired(counts.expired)}</AdminStatusChip> : null}
            {counts.missing ? <AdminStatusChip tone="idle">{p.count.missing(counts.missing)}</AdminStatusChip> : null}
          </span>
        }
      >
        <AdminDataTable caption={p.title} columns={columns} rows={providers} rowKey={(row) => row.provider} cardTitle={(row) => row.provider} />
      </AdminTile>
    </div>
  );
}

/** One provider's re-check draft beside the applied record, with the two buttons that settle it. */
export function ProviderTermsDraftPanel({
  c,
  row,
  busy,
  onDiscard,
  onApply,
}: {
  c: CodingMessages;
  row: CodingProviderRow;
  busy: boolean;
  onDiscard: () => void;
  onApply: () => void;
}) {
  const p = c.providers;
  if (!row.draft) return null;
  const comparison = providerTermsComparison(row.terms, row.draft);
  const show = (key: (typeof comparison)[number]["key"], value: string | boolean | null) =>
    value === null ? p.none : key === "resale" ? (value ? p.allowed : p.denied) : String(value);
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-2xl border border-blue-500/40 bg-zinc-900 p-4" data-testid="coding-provider-draft">
      <header className="flex flex-wrap items-start gap-2">
        <AdminProviderMark provider={row.provider} size={24} />
        <div className="min-w-0 flex-1">
          <h3 className="font-bold text-zinc-100">{p.draftTitle(row.provider)}</h3>
          <p className="text-xs text-zinc-400">{p.draftMeta((row.draftCreatedAt ?? "").slice(0, 16).replace("T", " "))}</p>
        </div>
        <span className="rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-bold text-blue-300">{c.detail.llmDraft}</span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead>
            <tr className="text-xs text-zinc-400">
              <th className="py-2 pr-3 font-bold">{p.compare.item}</th>
              <th className="py-2 pr-3 font-bold">{p.compare.current(row.checkedAt)}</th>
              <th className="py-2 font-bold">{p.compare.draft}</th>
            </tr>
          </thead>
          <tbody>
            {comparison.map((entry) => (
              <tr key={entry.key} className="border-t border-zinc-800" data-testid="coding-provider-compare" data-changed={entry.changed ? "true" : "false"}>
                <th className="py-2 pr-3 text-xs font-bold text-zinc-100">{p.rows[entry.key]}</th>
                <td className="break-all py-2 pr-3 text-xs text-zinc-300">{show(entry.key, entry.before)}</td>
                <td className="break-all py-2 text-xs">
                  <span className={entry.changed ? "font-bold text-amber-300" : "text-zinc-200"}>{show(entry.key, entry.after)}</span>{" "}
                  <span className={`ml-1 rounded px-1 text-[10px] font-bold ${entry.changed ? "bg-amber-500/20 text-amber-300" : "text-zinc-500"}`}>
                    {entry.changed ? p.changed : p.unchanged}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-1 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-zinc-200">
        <li className="flex gap-1.5">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden />
          {p.checksOfficial(row.hosts.join(", "))}
        </li>
        {row.draft.evidence ? (
          <li className="flex gap-1.5">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden />
            {p.checksEvidence(row.draft.evidence)}
          </li>
        ) : null}
      </ul>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <p className="min-w-0 flex-1 text-xs text-zinc-400">{p.applyNote(row.provider, row.modelCount)}</p>
        <div className="flex gap-2">
          <AdminWriteButton variant="secondary" disabled={busy} onClick={onDiscard} data-testid="coding-provider-discard">
            {p.discard}
          </AdminWriteButton>
          <AdminWriteButton disabled={busy} onClick={onApply} data-testid="coding-provider-apply">
            {p.apply}
          </AdminWriteButton>
        </div>
      </div>
    </section>
  );
}

export type ProviderStartForm = { provider: string; termsUrl: string; retentionUrl: string; extraUrl: string };

const field =
  "mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500";

/** The first check of a provider: its terms and retention pages (and, optionally, a region page). */
export function ProviderStartFields({
  c,
  value,
  hosts,
  onChange,
}: {
  c: CodingMessages;
  value: ProviderStartForm;
  hosts: readonly string[];
  onChange: (value: ProviderStartForm) => void;
}) {
  const p = c.providers;
  const input = (key: "termsUrl" | "retentionUrl" | "extraUrl", label: string) => (
    <label className="text-xs font-bold text-zinc-300">
      {label}
      <input
        type="url"
        className={field}
        value={value[key]}
        onChange={(event) => onChange({ ...value, [key]: event.target.value })}
        data-testid={`coding-provider-${key}`}
      />
    </label>
  );
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="coding-provider-start">
      {input("termsUrl", p.termsUrl)}
      {input("retentionUrl", p.retentionUrl)}
      {input("extraUrl", p.extraUrl)}
      {hosts.length ? <p className="text-xs text-zinc-500">{p.hosts(hosts.join(", "))}</p> : null}
    </div>
  );
}
