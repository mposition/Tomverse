"use client";

import { useCallback, useState } from "react";
import { Loader2, Lock, RefreshCw } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";
import { discardResponseBody } from "@/lib/discardResponseBody";
import type { MarketingConsoleSection } from "@/lib/marketingConsoleSections";

type Availability = { available: true } | { available: false; stage: "S4" | "S5" };

type SwitchState =
  | "on"
  | "off"
  | "scope-valid"
  | "scope-invalid"
  | "no-scope"
  | "unreadable";

type Row = Record<string, unknown>;

export type MarketingConsoleView = {
  section: MarketingConsoleSection;
  availability: Availability;
  ordering: "newest" | "by-account";
  pageSize: number;
  rows: Row[];
  switches: Record<string, SwitchState>;
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
 * The first payload arrives from the page's server component, so the rows are
 * in the HTML rather than appearing after hydration. Refreshing calls the same
 * loader through `GET /api/admin/marketing`.
 *
 * One component for six sections because the sections differ in their columns
 * and in nothing else: the same switch strip, the same "newest N, not a total"
 * sentence, and the same treatment of a section a later stage owns. Six
 * components would be five copies of that sentence to keep in step.
 */
export function AdminMarketingPanel({ initial }: { initial: MarketingConsoleView }) {
  const m = useAdminMessages(adminMarketingMessages);
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/marketing?section=${encodeURIComponent(initial.section)}`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        // Every path consumes the body, not only the one that parses it:
        // `/api/*` answers `private, no-store`, under which an unconsumed body
        // did not reach `requestfinished` (lib/discardResponseBody.ts).
        await discardResponseBody(response);
        throw new Error(String(response.status));
      }
      setView((await response.json()) as MarketingConsoleView);
    } catch {
      setError(m.loadFailed);
    } finally {
      setBusy(false);
    }
  }, [initial.section, m.loadFailed]);

  const heading = {
    queue: { title: m.queueTitle, description: m.queueDescription },
    published: { title: m.publishedTitle, description: m.publishedDescription },
    accounts: { title: m.accountsTitle, description: m.accountsDescription },
    reports: { title: m.reportsTitle, description: m.reportsDescription },
    experiments: { title: m.experimentsTitle, description: m.experimentsDescription },
    comments: { title: m.commentsTitle, description: m.commentsDescription },
  }[view.section];

  const unavailable = view.availability.available ? null : view.availability;

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
            Marketing
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">{heading.title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            {heading.description}
          </p>
          <p className="mt-2 text-xs text-zinc-500">{m.readOnly}</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-bold text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {m.refresh}
        </button>
      </div>

      <MarketingSwitchStrip switches={view.switches} m={m} />

      {error ? <p className="mt-4 text-sm text-red-300">{error}</p> : null}

      {unavailable ? (
        <p className="mt-4 flex items-start gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 text-sm leading-6 text-zinc-300">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
          {unavailable.stage === "S4" ? m.unavailableS4 : m.unavailableS5}
        </p>
      ) : (
        <>
          <p className="mt-4 text-xs text-zinc-500">
            {m.showing.replace("{count}", String(view.pageSize))}
          </p>
          {view.rows.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-400">{m.empty}</p>
          ) : (
            <div className="mt-4 grid gap-2">
              {view.rows.map((row) => (
                <article
                  key={String(row.id)}
                  className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4"
                >
                  <MarketingRow section={view.section} row={row} m={m} />
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * What is switched on, on every section.
 *
 * docs/policy/marketing-automation.md §6.1 makes each capability its own
 * switch, and the page's job is to answer "why did nothing publish".
 * "Drafts: off" is that answer, and it belongs beside the empty queue rather
 * than in another workspace.
 * `unreadable` is its own word: a read that failed is not evidence of `off`.
 */
function MarketingSwitchStrip({
  switches,
  m,
}: {
  switches: Record<string, SwitchState>;
  m: Record<string, string>;
}) {
  const labels: [string, string][] = [
    ["drafts", m.switchDrafts],
    ["publish", m.switchPublish],
    ["autoPublish", m.switchAutoPublish],
    ["experiments", m.switchExperiments],
    ["webhookShadow", m.switchWebhookShadow],
    ["webhookApplyScope", m.switchWebhookApply],
  ];
  const word = (value: SwitchState) =>
    ({
      on: m.switchOn,
      off: m.switchOff,
      "scope-valid": m.switchScopeValid,
      "scope-invalid": m.switchScopeInvalid,
      "no-scope": m.switchNoScope,
      unreadable: m.switchUnreadable,
    })[value];
  // Only the five booleans go green. A stored apply scope is a document, not
  // an active capability -- the pipeline behind it is incomplete -- so it is
  // never drawn as though something were switched on.
  const tone = (value: SwitchState) =>
    value === "on"
      ? "text-emerald-300"
      : value === "unreadable" || value === "scope-invalid"
        ? "text-amber-300"
        : "text-zinc-400";

  return (
    <div
      data-testid="marketing-switches"
      className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-3"
    >
      <p className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">
        {m.switchesTitle}
      </p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        {labels.map(([key, label]) => (
          <div key={key} className="flex items-baseline justify-between gap-2">
            <dt className="truncate text-xs text-zinc-400">{label}</dt>
            <dd
              data-state={switches[key] ?? "unreadable"}
              className={`text-xs font-bold ${tone(switches[key] ?? "unreadable")}`}
            >
              {word(switches[key] ?? "unreadable")}
            </dd>
          </div>
        ))}
      </dl>
    </div>
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
      <>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={m.colAccount} value={`${row.accountSlug} / ${row.channel}`} />
          <Field label={m.colStatus} value={`${row.status} / ${row.mode}`} />
          <Field label={m.colScheduled} value={stamp(row.scheduledAt) ?? m.none} />
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
          <Field label={m.colAttempts} value={String(row.publishAttempt ?? 0)} />
          <Field
            label={m.colProblem}
            value={
              text(row.errorCode) ??
              (stamp(row.outcomeUnknownAt)
                ? `${m.outcomeUnknown} ${stamp(row.outcomeUnknownAt)}`
                : m.none)
            }
          />
        </div>
      </>
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
      <Field label={m.colSource} value={String(row.sourceVersion)} />
    </div>
  );
}
