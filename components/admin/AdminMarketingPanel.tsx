"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";
import type { MarketingConsoleSection } from "@/lib/marketingConsoleSections";

type Availability = { available: true } | { available: false; stage: "S4" | "S5" };

type Row = Record<string, unknown>;

type Payload = {
  section: MarketingConsoleSection;
  availability: Availability;
  pageSize: number;
  rows: Row[];
};

const stamp = (value: unknown) => {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const text = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * The whole Marketing console, read only.
 *
 * One component for six sections because the sections differ in their columns
 * and in nothing else: the same fetch, the same "newest N, not a total"
 * sentence, and the same treatment of a section a later stage owns. Splitting
 * it into six would give five copies of that sentence to keep in step.
 */
export function AdminMarketingPanel({ section }: { section: MarketingConsoleSection }) {
  const m = useAdminMessages(adminMarketingMessages);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/marketing?section=${encodeURIComponent(section)}`,
        { cache: "no-store" }
      );
      if (!response.ok) throw new Error(String(response.status));
      setPayload((await response.json()) as Payload);
    } catch {
      setPayload(null);
      setError(m.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [section, m.loadFailed]);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const heading = {
    queue: { title: m.queueTitle, description: m.queueDescription },
    published: { title: m.publishedTitle, description: m.publishedDescription },
    accounts: { title: m.accountsTitle, description: m.accountsDescription },
    reports: { title: m.reportsTitle, description: m.reportsDescription },
    experiments: { title: m.reportsTitle, description: "" },
    comments: { title: m.reportsTitle, description: "" },
  }[section];

  const unavailable =
    payload && !payload.availability.available ? payload.availability : null;

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        Marketing
      </p>
      <h2 className="mt-2 text-2xl font-black text-white">{heading.title}</h2>
      {heading.description ? (
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {heading.description}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-zinc-500">{m.readOnly}</p>

      {loading ? (
        <p className="mt-5 flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          {m.loading}
        </p>
      ) : null}

      {error ? <p className="mt-5 text-sm text-red-300">{error}</p> : null}

      {unavailable ? (
        <p className="mt-5 flex items-start gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 text-sm leading-6 text-zinc-300">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          {unavailable.stage === "S4" ? m.unavailableS4 : m.unavailableS5}
        </p>
      ) : null}

      {payload && payload.availability.available ? (
        <>
          <p className="mt-4 text-xs text-zinc-500">
            {m.showing.replace("{count}", String(payload.pageSize))}
          </p>
          {payload.rows.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-400">{m.empty}</p>
          ) : (
            <div className="mt-4 grid gap-2">
              {payload.rows.map((row) => (
                <article
                  key={String(row.id)}
                  className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4"
                >
                  <MarketingRow section={section} row={row} m={m} />
                </article>
              ))}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className="mt-0.5 truncate text-sm text-zinc-200">{value}</p>
    </div>
  );
}

function MarketingRow({
  section,
  row,
  m,
}: {
  section: MarketingConsoleSection;
  row: Row;
  m: Record<string, string>;
}) {
  if (section === "queue") {
    return (
      <>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={m.colAccount} value={`${row.accountSlug} / ${row.channel}`} />
          <Field label={m.colLocale} value={String(row.locale)} />
          <Field label={m.colStatus} value={`${row.status} / ${row.mode}`} />
          <Field
            label={m.colVerdict}
            value={
              [row.guardDecision as string, ...(row.guardCodes as string[])]
                .filter(Boolean)
                .join(", ") || m.none
            }
          />
        </div>
        <p className="mt-3 text-sm leading-6 text-zinc-300">
          {text(row.excerpt) ?? m.none}
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          {m.colCreated} {stamp(row.createdAt) ?? m.none} UTC / {m.colExpires}{" "}
          {stamp(row.approvalExpiresAt) ?? m.none}
        </p>
      </>
    );
  }

  if (section === "published") {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={m.colAccount} value={`${row.accountSlug} / ${row.channel}`} />
        <Field label={m.colStatus} value={`${row.status} / ${row.mode}`} />
        <Field label={m.colPublished} value={stamp(row.publishedAt) ?? m.none} />
        <Field
          label={m.colVerified}
          value={
            stamp(row.verifiedPublicAt)
              ? `${stamp(row.verifiedPublicAt)} (${row.verificationMethod ?? m.none})`
              : m.none
          }
        />
        <Field label={m.colUrl} value={text(row.externalUrl) ?? m.none} />
      </div>
    );
  }

  if (section === "accounts") {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label={m.colAccount}
          value={`${row.accountSlug} / ${row.channel} / ${row.provider}`}
        />
        <Field label={m.colStatus} value={String(row.status)} />
        <Field
          label={m.colLocale}
          value={`${row.defaultLocale} (${(row.allowedLocales as string[]).join(", ")})`}
        />
        <Field
          label={m.colCaps}
          value={`${row.dailyCapOverride ?? m.noCap} / ${row.weeklyCapOverride ?? m.noCap}`}
        />
        <Field
          label={m.colPaused}
          value={
            stamp(row.pausedAt)
              ? `${stamp(row.pausedAt)} (${row.pauseReasonCode ?? m.none}, from ${row.pausedFromMode ?? m.none})`
              : m.notPaused
          }
        />
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label={m.colKind} value={String(row.kind)} />
      <Field
        label={m.colPeriod}
        value={`${stamp(row.periodStart) ?? m.none} - ${stamp(row.periodEnd) ?? m.none}`}
      />
      <Field label={m.colCreated} value={stamp(row.createdAt) ?? m.none} />
      <Field label={m.colStatus} value={String(row.sourceVersion)} />
    </div>
  );
}
