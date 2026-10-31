"use client";

import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Check, ChevronDown, Loader2, Lock, RefreshCw } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import {
  MARKETING_CHECKED,
  MarketingActionRail,
  instantFromLocalInput,
  localDateTimeValue,
  type MarketingAction,
} from "@/components/admin/MarketingActions";
import { MarketingWebhookProduction } from "@/components/admin/MarketingWebhookProduction";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";
import { discardResponseBody } from "@/lib/discardResponseBody";
import {
  MARKETING_CHANNEL_CAPS,
  MARKETING_LOCALES,
  MARKETING_PAUSE_REASON_CODES,
  MARKETING_PROVIDERS,
  MARKETING_RESUME_REASON_CODES,
} from "@/lib/marketingAutomationSchema";
import {
  MARKETING_CONSOLE_SWITCH_CONTROLS,
  type MarketingConsoleSection,
} from "@/lib/marketingConsoleSections";
import { adminFetch } from "@/lib/adminFetch";
import type { MarketingConsoleOverview } from "@/lib/marketingConsoleOverview";

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
  ordering: "newest" | "by-account" | "by-status";
  pageSize: number;
  rows: Row[];
  switches: Record<string, SwitchState>;
  canWrite: boolean;
  configGeneration: number | null;
  /** The generator's model and monthly LLM cap (lib/marketingConsoleRead.ts). */
  llm: LlmView;
  /** The four numbers at the top (lib/marketingConsoleOverview.ts). */
  overview: MarketingConsoleOverview;
  /** Staging only; null everywhere else (lib/marketingConsoleRead.ts). */
  webhookStaging: WebhookStagingView | null;
  /** Rows were left out at the section's limit (lib/marketingConsoleRead.ts). */
  truncated?: boolean;
};

type LlmView = {
  /** Null when the stored document cannot be read. */
  settings: { model: string | null; monthlyUsdCap: string | null } | null;
  version: string | null;
  models: Array<{ model: string; name: string; worstCallMicroUsd: number; unavailable: string | null }>;
};

type WebhookStagingView = {
  readable: boolean;
  shadow: "on" | "off" | "unreadable";
  reportsReadable: boolean;
  reportLimit: number;
  faultArm: {
    eventIdDigest: string;
    state: "armed" | "consumed";
    generation: number;
    armedAt: string;
    expiresAt: string;
  } | null;
  faultArmUnreadable: boolean;
  /** Judged when the page was read; the screen does not consult a clock. */
  faultArmExpired: boolean;
  shadowReports: Array<{
    id: string;
    createdAt: string;
    eventIdDigest: string;
    eventType: string;
    channel: string | null;
    accountSlug: string | null;
    derivedStatus: string;
    statusQueryMatch: boolean;
  }>;
};

const stamp = (value: unknown) => {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const text = (value: unknown) => (typeof value === "string" ? value : null);
const str = (value: unknown) => (typeof value === "string" ? value : "");
const int = (value: unknown) => (typeof value === "number" ? value : 0);

/** An empty box means "no override", which is a value the writer accepts. */
const capOverride = (value: string): number | null => {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

/** A week out, which is the ordinary answer and still an editable one. */
const defaultApprovalExpiry = () =>
  localDateTimeValue(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());

const POST = (id: unknown, action: string) =>
  `/api/admin/marketing/posts/${encodeURIComponent(String(id))}/${action}`;
const ACCOUNT = (id: unknown, action: string) =>
  `/api/admin/marketing/accounts/${encodeURIComponent(String(id))}/${action}`;
const COMPETITOR_DECISION = (id: unknown) =>
  `/api/admin/marketing/competitors/${encodeURIComponent(String(id))}/decision`;
const ASSET_PATH = (id: unknown, leaf: "decision" | "preview") =>
  `/api/admin/marketing/assets/${encodeURIComponent(String(id))}/${leaf}`;

/**
 * What the person typed into a page box: one URL per line. Not split on
 * commas, which a URL may contain.
 */
const pageList = (value: string) =>
  value
    .split("\n")
    .map((page) => page.trim())
    .filter((page) => page !== "");

/** What the person typed into a host box, as the list the route parses. */
const hostList = (value: string) =>
  value
    .split(/[\s,]+/u)
    .map((host) => host.trim())
    .filter((host) => host !== "");

/**
 * The whole Marketing console.
 *
 * The first payload arrives from the page's server component, so the rows are
 * in the HTML rather than appearing after hydration. Refreshing calls the same
 * loader through `GET /api/admin/marketing`, and so does every control here
 * once its write lands -- a screen that has just changed a row and still shows
 * the old one is a screen that will be acted on twice.
 *
 * One component for six sections because the sections differ in their columns
 * and in nothing else: the same switch strip, the same "newest N, not a total"
 * sentence, and the same treatment of a section a later stage owns. Six
 * components would be five copies of that sentence to keep in step.
 *
 * Every control sends a compare-and-set. The values it sends back -- an
 * envelope digest, a history version, a connection generation, a
 * configuration generation -- are read from the payload this screen rendered,
 * so a change is a decision about the row the operator was looking at rather
 * than whichever row is there when the request lands.
 */
export function AdminMarketingPanel({
  initial,
  tabs,
}: {
  initial: MarketingConsoleView;
  /** The section strip, a server component the page renders and this panel places. */
  tabs?: ReactNode;
}) {
  const m = useAdminMessages(adminMarketingMessages);
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<string>("");

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await adminFetch(
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

  const unavailable = view.availability.available ? null : view.availability;
  const done = () => void refresh();
  // A filter over the rows this page already read, never a new query: the
  // list says how many it holds, and the filter only narrows what is drawn.
  const channels = [...new Set(view.rows.map((row) => str(row.channel)).filter(Boolean))].sort();
  const rows = channel ? view.rows.filter((row) => str(row.channel) === channel) : view.rows;
  const now = view.overview.readAt;

  // Three bands, in the order an operator asks the questions: what needs me
  // (the overview), what is in this section (the list, under its tabs), and
  // what is switched on and what it costs (the settings rail). The rail is
  // beside the list on a wide screen and below it on a narrow one.
  return (
    <section className="flex min-w-0 flex-col gap-6" data-testid="marketing-console">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <p className="text-xs text-zinc-500">{m.consoleEyebrow}</p>
          <h2 className="mt-1 text-2xl font-bold text-white">{m.consoleTitle}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-400">{m.consoleDescription}</p>
          {view.canWrite ? null : <p className="mt-1 text-xs text-zinc-500">{m.readOnlyNote}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <MarketingTag tone="neutral">{view.overview.environment}</MarketingTag>
          <span className="text-xs text-zinc-500">
            {m.updatedAt.replace("{time}", `${(stamp(now) ?? "").slice(11)} UTC`)}
          </span>
          <button
            type="button"
            onClick={done}
            disabled={busy}
            className="inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-[13px] font-semibold text-zinc-100 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {m.refresh}
          </button>
        </div>
      </header>

      <MarketingOverview view={view} m={m} />

      {error ? (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {tabs}
          {unavailable ? (
            <p className="flex items-start gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-5 text-sm leading-6 text-zinc-300">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
              {unavailable.stage === "S4" ? m.unavailableS4 : m.unavailableS5}
            </p>
          ) : (
            <>
              {view.section === "accounts" && view.canWrite ? (
                <MarketingAccountCreate section={view.section} onDone={done} m={m} />
              ) : null}
              {view.section === "competitors" && view.canWrite ? (
                <MarketingCompetitorCreate section={view.section} onDone={done} m={m} />
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-zinc-500">
                  {(view.section === "assets"
                    ? m.showingAssets
                    : view.ordering === "by-status"
                      ? m.showingByStatus
                      : m.showing
                  ).replace(
                    "{count}",
                    String(view.pageSize)
                  )}
                  {" · "}
                  {m.shownCount.replace("{n}", String(rows.length))}
                </p>
                {channels.length > 1 ? (
                  <label className="relative inline-flex items-center">
                    <span className="sr-only">{m.filterChannel}</span>
                    <select
                      data-testid="marketing-channel-filter"
                      value={channel}
                      onChange={(event) => setChannel(event.target.value)}
                      className="min-h-11 cursor-pointer appearance-none rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-3 pr-8 text-xs text-zinc-300 hover:border-zinc-700 focus:border-blue-500 focus:outline-none"
                    >
                      <option value="">{m.filterAllChannels}</option>
                      {channels.map((value) => (
                        <option key={value} value={value}>
                          {channelName(value)}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-zinc-500" />
                  </label>
                ) : null}
                {view.truncated ? (
                  <p className="w-full text-xs font-semibold text-amber-300">{m.truncatedAtLimit}</p>
                ) : null}
              </div>
              {rows.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-400">
                  {m.empty}
                </p>
              ) : (
                <div className="grid gap-3">
                  {rows.map((row) => (
                    <article
                      key={String(row.id)}
                      data-testid="marketing-row"
                      className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5"
                    >
                      <MarketingRow section={view.section} row={row} now={now} m={m} />
                      <MarketingActionRail
                        actions={view.canWrite ? rowActions(view.section, row, m) : []}
                        section={view.section}
                        onDone={done}
                        m={m}
                      />
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-4" aria-label={m.automationTitle}>
          <MarketingSwitchStrip
            switches={view.switches}
            canWrite={view.canWrite}
            configGeneration={view.configGeneration}
            section={view.section}
            onDone={done}
            m={m}
          />
          <MarketingLlmSettings
            llm={view.llm}
            spend={view.overview.llm}
            canWrite={view.canWrite}
            section={view.section}
            onDone={done}
            m={m}
          />
          {view.webhookStaging || view.canWrite ? (
            <div data-testid="marketing-webhook-card" className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-[15px] font-semibold text-white">{m.webhookCardTitle}</h3>
                <MarketingTag tone={view.switches.webhookShadow === "on" ? "success" : "neutral"}>
                  {view.switches.webhookShadow === "on" ? m.switchOn : m.switchOff}
                </MarketingTag>
              </div>
              <p className="mt-1 text-xs leading-5 text-zinc-500">{m.webhookCardHint}</p>
              <div className="mt-4 grid gap-5 [&>*+*]:border-t [&>*+*]:border-zinc-800 [&>*+*]:pt-5">
                {view.webhookStaging ? (
                  <MarketingWebhookStaging
                    staging={view.webhookStaging}
                    canWrite={view.canWrite}
                    section={view.section}
                    onDone={done}
                    m={m}
                  />
                ) : null}
                {view.canWrite ? (
                  <MarketingWebhookVerificationSign section={view.section} onDone={done} m={m} />
                ) : null}
                {view.canWrite ? <MarketingWebhookProduction section={view.section} /> : null}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

/**
 * How long ago (or how long until) an instant was, measured from when the page
 * was read on the server -- not from the browser's clock -- so the server's
 * render and the browser's say the same thing.
 */
const relative = (iso: unknown, now: string, m: Record<string, string>): string | null => {
  if (typeof iso !== "string") return null;
  const at = Date.parse(iso);
  const reference = Date.parse(now);
  if (Number.isNaN(at) || Number.isNaN(reference)) return null;
  const ahead = at > reference;
  const minutes = Math.round(Math.abs(reference - at) / 60_000);
  if (minutes < 1) return m.timeJustNow;
  if (minutes < 60) return (ahead ? m.timeMinutesLeft : m.timeMinutesAgo).replace("{n}", String(minutes));
  const hours = Math.round(minutes / 60);
  if (hours < 48) return (ahead ? m.timeHoursLeft : m.timeHoursAgo).replace("{n}", String(hours));
  return (ahead ? m.timeDaysLeft : m.timeDaysAgo).replace("{n}", String(Math.round(hours / 24)));
};

/** A small pill whose colour says what kind of state it is. */
export function MarketingTag({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "accent" | "neutral";
  children: ReactNode;
}) {
  const colour = {
    success: "bg-emerald-500/15 text-emerald-300",
    warning: "bg-amber-500/15 text-amber-300",
    danger: "bg-red-500/15 text-red-300",
    accent: "bg-blue-500/15 text-blue-300",
    neutral: "bg-zinc-800 text-zinc-400",
  }[tone];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${colour}`}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "accent" | "neutral"> = {
  drafted: "neutral",
  guard_rejected: "danger",
  pending_approval: "accent",
  approved: "success",
  rejected: "neutral",
  approval_expired: "warning",
  scheduled: "accent",
  publishing: "accent",
  published: "success",
  failed: "danger",
  outcome_unknown: "warning",
  verified: "success",
  removed_by_platform: "warning",
  deleted: "neutral",
  connect_pending: "warning",
  approval_mode: "success",
  autonomous_mode: "accent",
  paused: "warning",
  disconnected: "danger",
  proposed: "warning",
  submitted: "accent",
  retired: "neutral",
};

/** A status as words, in the colour of what it means; an unknown one as itself. */
function StatusTag({ status, m }: { status: unknown; m: Record<string, string> }) {
  const value = typeof status === "string" ? status : "";
  return (
    <MarketingTag tone={STATUS_TONE[value] ?? "neutral"}>
      {m[`status_${value}`] ?? (value.replaceAll("_", " ") || m.none)}
    </MarketingTag>
  );
}

function StatCard({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
      <p className="text-[13px] font-medium text-zinc-400">{label}</p>
      {children}
    </div>
  );
}

const StatValue = ({ value, unit, tone }: { value: ReactNode; unit?: string; tone?: "accent" }) => (
  <p className="flex items-baseline gap-1.5">
    <span className={`text-3xl font-semibold tabular-nums ${tone === "accent" ? "text-blue-300" : "text-white"}`}>
      {value}
    </span>
    {unit ? <span className="text-sm text-zinc-400">{unit}</span> : null}
  </p>
);

const StatCaption = ({ children }: { children: ReactNode }) => (
  <p className="text-xs leading-5 text-zinc-500">{children}</p>
);

/**
 * The four numbers an operator opens this page for. Each was read on its own
 * (lib/marketingConsoleOverview.ts); one that could not be read says so rather
 * than showing zero.
 */
function MarketingOverview({ view, m }: { view: MarketingConsoleView; m: Record<string, string> }) {
  const { pending, llm, lastRun, accounts, competitors, readAt } = view.overview;
  const capRaw = view.llm.settings?.monthlyUsdCap ?? null;
  const capMicro = capRaw === null ? null : Math.round(Number(capRaw) * 1_000_000);
  const used = llm && capMicro ? Math.min(100, (llm.countedMicroUsd / capMicro) * 100) : 0;
  const unreadable = <p className="text-sm font-semibold text-amber-300">{m.overviewUnreadable}</p>;

  return (
    <div data-testid="marketing-overview" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label={m.overviewPending} testId="marketing-overview-pending">
        {pending ? (
          <>
            <StatValue value={pending.count} unit={m.unitCount} tone={pending.count > 0 ? "accent" : undefined} />
            <StatCaption>
              {pending.oldestAt
                ? m.overviewPendingAge.replace("{age}", relative(pending.oldestAt, readAt, m) ?? m.none)
                : m.overviewPendingNone}
            </StatCaption>
            {pending.count > 0 ? (
              <Link
                href="/admin/marketing?tab=queue"
                className="inline-flex min-h-11 items-center gap-1 self-start text-[13px] font-semibold text-blue-300 hover:underline"
              >
                {m.overviewReview}
                <ArrowRight className="h-4 w-4" />
              </Link>
            ) : null}
          </>
        ) : (
          unreadable
        )}
      </StatCard>

      <StatCard label={m.overviewSpend} testId="marketing-overview-spend">
        {llm ? (
          <>
            <StatValue
              value={usd(llm.countedMicroUsd)}
              unit={capMicro ? m.overviewSpendOf.replace("{cap}", usd(capMicro)) : m.overviewNoCap}
            />
            {capMicro ? <SpendMeter percent={used} label={m.overviewSpend} /> : null}
            <StatCaption>
              {m.overviewSpendModel
                .replace("{model}", view.llm.settings?.model ?? m.llmUnset)
                .replace("{calls}", String(llm.calls))
                .replace("{percent}", String(Math.round(used)))}
              <br />
              {m.overviewSpendTokens.replace("{tokens}", usd(llm.tokenMicroUsd))}
            </StatCaption>
          </>
        ) : (
          unreadable
        )}
      </StatCard>

      <StatCard label={m.overviewRun} testId="marketing-overview-run">
        {lastRun === null ? (
          unreadable
        ) : lastRun.at === null ? (
          <StatCaption>{m.overviewRunNever}</StatCaption>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2">
              <span className="text-3xl font-semibold tabular-nums text-white">
                {(stamp(lastRun.at) ?? "").slice(11)}
              </span>
              {lastRun.factsKept === null ? null : lastRun.factsKept > 0 ? (
                <MarketingTag tone="success">
                  <Check className="h-3 w-3" />
                  {m.overviewRunOk}
                </MarketingTag>
              ) : (
                <MarketingTag tone="warning">
                  <AlertTriangle className="h-3 w-3" />
                  {m.overviewRunNoFacts}
                </MarketingTag>
              )}
            </p>
            <StatCaption>
              {`${(stamp(lastRun.at) ?? "").slice(0, 10)} UTC · `}
              {m.overviewRunCounts
                .replace("{competitors}", competitors ? String(competitors.approved) : m.none)
                .replace("{kept}", lastRun.factsKept === null ? m.none : String(lastRun.factsKept))
                .replace("{dropped}", lastRun.factsDropped === null ? m.none : String(lastRun.factsDropped))}
            </StatCaption>
          </>
        )}
      </StatCard>

      <StatCard label={m.overviewAccounts} testId="marketing-overview-accounts">
        {accounts ? (
          <>
            <StatValue value={accounts.total} unit={m.unitAccounts} />
            <StatCaption>
              {m.overviewAccountsCaption
                .replace("{approval}", String(accounts.byStatus.approval_mode ?? 0))
                .replace("{autonomous}", String(accounts.byStatus.autonomous_mode ?? 0))
                .replace("{paused}", String(accounts.byStatus.paused ?? 0))}
            </StatCaption>
          </>
        ) : (
          unreadable
        )}
      </StatCard>
    </div>
  );
}

/** How much of the monthly cap is counted, in the colour of how close it is. */
function SpendMeter({ percent, label }: { percent: number; label: string }) {
  const colour = percent >= 90 ? "bg-red-500" : percent >= 70 ? "bg-amber-500" : "bg-blue-500";
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-label={label}
    >
      <div className={`h-full rounded-full ${colour}`} style={{ width: `${Math.max(percent, 1)}%` }} />
    </div>
  );
}

/**
 * What is switched on, on every section, and the three an operator may change.
 *
 * docs/policy/marketing-automation.md §6.1 makes each capability its own
 * switch, and the page's job is to answer "why did nothing publish".
 * "Drafts: off" is that answer, and it belongs beside the empty queue rather
 * than in another workspace.
 * `unreadable` is its own word: a read that failed is not evidence of `off`.
 *
 * A toggle is offered only for a switch whose state was actually read and only
 * when the configuration generation was read with it. Both come from the same
 * snapshot, so a screen cannot save a change against a state nobody saw;
 * without the generation there is nothing to compare and set against, and a
 * control whose only outcome is 409 is not a control.
 */
function MarketingSwitchStrip({
  switches,
  canWrite,
  configGeneration,
  section,
  onDone,
  m,
}: {
  switches: Record<string, SwitchState>;
  canWrite: boolean;
  configGeneration: number | null;
  section: string;
  onDone: () => void;
  m: Record<string, string>;
}) {
  // The three an operator can move, each with what it does and a switch, then
  // the three that are only read here, folded away: they matter when something
  // looks wrong, not on every visit.
  const main: { key: string; name: (typeof MARKETING_CONSOLE_SWITCH_CONTROLS)[number]["name"]; label: string; hint: string }[] = [
    { key: "drafts", name: "drafts", label: m.switchDrafts, hint: m.switchDraftsHint },
    { key: "publish", name: "publish", label: m.switchPublish, hint: m.switchPublishHint },
    { key: "autoPublish", name: "autonomous", label: m.switchAutoPublish, hint: m.switchAutoPublishHint },
  ];
  const advanced: [string, string][] = [
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
      ? "success"
      : value === "unreadable" || value === "scope-invalid"
        ? "warning"
        : "neutral";
  const stateOf = (key: string) => switches[key] ?? "unreadable";

  // One switch per row. A switch whose state cannot be read, or a viewer who
  // may not write, gets no control at all: a switch has to show the real
  // position, and there is no real position to show.
  const toggleFor = (control: (typeof main)[number]): MarketingAction | null => {
    const state = switches[control.key];
    if (!canWrite || configGeneration === null || (state !== "on" && state !== "off")) return null;
    const turningOn = state === "off";
    return {
      id: `switch-${control.name}`,
      label: (turningOn ? m.switchTurnOn : m.switchTurnOff).replace("{switch}", control.label),
      path: "/api/admin/marketing/settings",
      // The route exports PATCH. Sending POST answered 405, which reached the
      // operator as "that did not go through" -- three switches that looked
      // broken rather than misaddressed.
      method: "PATCH",
      checked: state === "on",
      // Two switches the writer is certain to refuse, each drawn disabled with
      // its reason rather than hidden: someone looking for a switch should
      // find out why it is not theirs to move, and a control whose only
      // outcome is a 409 teaches them that this screen's buttons are guesses.
      //
      // Publishing cannot go on before the publisher exists (S2c); the writer
      // answers `publisher_capability_unavailable`. Autonomous cannot go on
      // while drafts or publishing are off; the writer answers
      // `autonomous_needs_drafts_and_publish`.
      unavailable: !turningOn
        ? undefined
        : control.name === "publish"
          ? m.switchPublishUnavailable
          : control.name === "autonomous" && (switches.drafts !== "on" || switches.publish !== "on")
            ? m.switchAutonomousNeedsBoth
            : undefined,
      confirm: turningOn ? m.switchConfirmOn : undefined,
      body: () => ({
        switch: control.name,
        enabled: turningOn,
        expectedConfigGeneration: configGeneration,
      }),
    };
  };

  return (
    <div data-testid="marketing-switches" className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
      <h3 className="text-[15px] font-semibold text-white">{m.automationTitle}</h3>
      <p className="mt-1 text-xs leading-5 text-zinc-500">{m.automationHint}</p>
      <dl className="mt-4 grid gap-4">
        {main.map((control) => {
          const action = toggleFor(control);
          return (
            <div key={control.key} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <dt className="text-sm font-medium text-zinc-100">{control.label}</dt>
                  <dd data-state={stateOf(control.key)}>
                    <MarketingTag tone={tone(stateOf(control.key))}>{word(stateOf(control.key))}</MarketingTag>
                  </dd>
                </div>
                {action?.unavailable ? (
                  <p id={`marketing-why-${action.id}`} className="mt-1 text-xs leading-5 text-amber-300">
                    {action.unavailable}
                  </p>
                ) : (
                  <p className="mt-1 text-xs leading-5 text-zinc-500">{control.hint}</p>
                )}
              </div>
              {action ? (
                <MarketingActionRail
                  actions={[action]}
                  section={section}
                  onDone={onDone}
                  m={m}
                  appearance="switch"
                />
              ) : null}
            </div>
          );
        })}
      </dl>
      <details className="group mt-4 border-t border-zinc-800 pt-3">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-[13px] font-medium text-zinc-400 hover:text-zinc-200">
          {m.switchAdvancedCount.replace("{count}", String(advanced.length))}
          <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
        </summary>
        <dl className="mt-2 grid gap-2">
          {advanced.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <dt className="text-[13px] text-zinc-400">{label}</dt>
              <dd data-state={stateOf(key)}>
                <MarketingTag tone={tone(stateOf(key))}>{word(stateOf(key))}</MarketingTag>
              </dd>
            </div>
          ))}
        </dl>
      </details>
      {/*
        Only when the version is genuinely unreadable. A reader who may not
        write has no missing version -- they have no business changing these
        -- and telling them something could not be read would send them
        looking for a fault that is not there.
      */}
      {canWrite && configGeneration === null ? (
        <p className="mt-3 text-xs text-amber-300">{m.switchNoGeneration}</p>
      ) : null}
    </div>
  );
}

/**
 * The generator's model and monthly LLM cap, set here instead of in Railway
 * variables (operator decision 2026-10-19). The models are the OpenAI ones the
 * chat price catalog prices; only one the ledger's limits accept can be
 * selected. The cost ledger reads these inside every reservation, so a change
 * applies to the next call.
 */
function MarketingLlmSettings({
  llm,
  spend,
  canWrite,
  section,
  onDone,
  m,
}: {
  llm: LlmView;
  spend: MarketingConsoleOverview["llm"];
  canWrite: boolean;
  section: string;
  onDone: () => void;
  m: Record<string, string>;
}) {
  const settings = llm.settings;
  const models = llm.models.filter((option) => option.unavailable === null);
  const selected = llm.models.find((option) => option.model === settings?.model) ?? null;
  const capMicro = settings?.monthlyUsdCap ? Math.round(Number(settings.monthlyUsdCap) * 1_000_000) : null;
  const percent = spend && capMicro ? Math.min(100, (spend.countedMicroUsd / capMicro) * 100) : 0;
  const action: MarketingAction[] = !canWrite
    ? []
    : [
        {
          id: "llm-settings",
          label: m.llmSave,
          path: "/api/admin/marketing/llm-settings",
          method: "PATCH",
          unavailable: models.length === 0 ? m.llmNoPins : undefined,
          confirm: m.llmConfirm,
          fields: [
            {
              name: "model",
              label: m.llmModel,
              kind: "select",
              options: [m.llmModelNone, ...models.map((option) => option.model)],
              initial: settings?.model ?? m.llmModelNone,
            },
            {
              name: "monthlyUsdCap",
              label: m.llmCap,
              kind: "text",
              initial: settings?.monthlyUsdCap ?? "",
              hint: m.llmCapHint,
            },
          ],
          body: (values) => ({
            model: !values.model || values.model === m.llmModelNone ? null : values.model,
            monthlyUsdCap: values.monthlyUsdCap?.trim() ? values.monthlyUsdCap.trim() : null,
            expectedVersion: llm.version,
          }),
        },
      ];
  const row = (label: string, value: ReactNode, testId?: string, mono?: boolean) => (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[13px] text-zinc-400">{label}</dt>
      <dd
        data-testid={testId}
        className={`truncate text-[13px] font-medium tabular-nums text-zinc-100 ${mono ? "font-mono" : ""}`}
      >
        {value}
      </dd>
    </div>
  );

  return (
    <div data-testid="marketing-llm-settings" className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
      <h3 className="text-[15px] font-semibold text-white">{m.llmTitle}</h3>
      {settings === null ? (
        <p className="mt-3 text-xs text-amber-300">{m.llmUnreadable}</p>
      ) : (
        <dl className="mt-4 grid gap-2.5">
          {row(m.llmModel, settings.model ?? m.llmUnset, "marketing-llm-model", true)}
          {row(m.llmCap, capMicro ? usd(capMicro) : m.llmUnset, "marketing-llm-cap")}
          {spend ? (
            <>
              {row(m.llmUsed, `${usd(spend.countedMicroUsd)}${capMicro ? `  ·  ${Math.round(percent)}%` : ""}`)}
              {capMicro ? <SpendMeter percent={percent} label={m.llmUsed} /> : null}
            </>
          ) : null}
          {selected ? row(m.llmWorstSearch, usd(selected.worstCallMicroUsd)) : null}
        </dl>
      )}
      {settings === null || settings.model === null || settings.monthlyUsdCap === null ? (
        <p className="mt-3 rounded-lg bg-zinc-800/60 px-3 py-2 text-xs leading-5 text-zinc-400">
          {m.llmNothingSpends}
        </p>
      ) : null}
      <div className="mt-4">
        <MarketingActionRail actions={action} section={section} onDone={onDone} m={m} appearance="block" />
      </div>
    </div>
  );
}

/**
 * The staging webhook exercise (S2e): the shadow switch, the fault latch, and
 * the newest shadow reports -- whose event digests are what gets armed.
 *
 * Drawn only when the loader returned a staging view, which it does only in
 * staging. Each report carries its own arm control, so the digest that is
 * armed is the one on the row rather than one copied by hand. Every write
 * compares against what this screen read: the shadow switch against its
 * current value, the arm against the generation shown.
 */
/**
 * Signing a webhook verification record (S2e-verification): the operator's
 * judgement and signature, in every environment -- production signs the record
 * the apply decision will read. The route checks the record is in the deployed
 * tree, hashes to the digest typed here and was made against this build; the
 * answer names the audit entry the sibling signature file must cite.
 */
export function MarketingWebhookVerificationSign({
  section,
  onDone,
  m,
}: {
  section: string;
  onDone: () => void;
  m: Record<string, string>;
}) {
  const sign: MarketingAction[] = [
    {
      id: "webhook-verification-sign",
      label: m.webhookSignAction,
      path: "/api/admin/marketing/webhook/verification-sign",
      confirm: m.webhookSignConfirm,
      fields: [
        { name: "recordId", label: m.fieldRecordId, kind: "text", initial: "", hint: m.hintRecordId },
        { name: "recordDigest", label: m.fieldRecordDigest, kind: "text", initial: "", hint: m.hintRecordDigest },
      ],
      describe: (result) => {
        const auditLogId = (result as { signatureAuditLogId?: unknown } | null)?.signatureAuditLogId;
        return typeof auditLogId === "string" ? m.webhookSignDone.replace("{auditLogId}", auditLogId) : null;
      },
      body: (values) => ({
        recordId: String(values.recordId ?? "").trim(),
        recordDigest: String(values.recordDigest ?? "").trim().toLowerCase(),
      }),
    },
  ];
  return (
    <div
      data-testid="marketing-webhook-verification-sign"
    >
      <p className="text-sm font-semibold text-zinc-100">{m.webhookSignTitle}</p>
      <p className="mt-1 text-xs text-zinc-500">{m.webhookSignNote}</p>
      <MarketingActionRail actions={sign} section={section} onDone={onDone} m={m} />
    </div>
  );
}

export function MarketingWebhookStaging({
  staging,
  canWrite,
  section,
  onDone,
  m,
}: {
  staging: WebhookStagingView;
  canWrite: boolean;
  section: string;
  onDone: () => void;
  m: Record<string, string>;
}) {
  // The switch as its writer reads it, not the strip's folded value: a stored
  // value the writer refuses gets no toggle.
  const shadow = staging.shadow;
  const shadowOn = shadow === "on";
  const shadowToggle: MarketingAction[] =
    canWrite && staging.readable && (shadow === "on" || shadow === "off")
      ? [
          {
            id: "webhook-shadow-toggle",
            label: shadowOn ? m.webhookShadowTurnOff : m.webhookShadowTurnOn,
            path: "/api/admin/marketing/webhook/shadow",
            method: "PATCH",
            confirm: shadowOn ? undefined : m.webhookShadowConfirmOn,
            body: () => ({ enabled: !shadowOn, expectedEnabled: shadowOn }),
          },
        ]
      : [];

  const arm = staging.faultArm;
  const short = (digest: string) => `${digest.slice(0, 12)}…`;
  const armLine = !staging.readable
    ? m.webhookUnreadable
    : staging.faultArmUnreadable
      ? m.webhookArmForeign
      : arm === null
        ? m.webhookArmNone
        : arm.state === "consumed"
          ? m.webhookArmConsumed.replace("{generation}", String(arm.generation))
          : staging.faultArmExpired
            ? m.webhookArmExpired.replace("{generation}", String(arm.generation))
            : m.webhookArmArmed
                .replace("{digest}", short(arm.eventIdDigest))
                .replace("{until}", stamp(arm.expiresAt) ?? arm.expiresAt)
                .replace("{generation}", String(arm.generation));
  // Arming compares against the generation shown; a value this console did not
  // write cannot be compared against, so no arm control is offered for it.
  const canArm = canWrite && staging.readable && !staging.faultArmUnreadable;
  const expectedGeneration = arm?.generation ?? 0;
  const describeArm = (result: unknown) => {
    const generation = (result as { generation?: unknown } | null)?.generation;
    return typeof generation === "number"
      ? m.webhookArmDone.replace("{generation}", String(generation))
      : null;
  };
  const ttlField = {
    name: "ttlMinutes",
    label: m.fieldTtlMinutes,
    kind: "number" as const,
    initial: "30",
    hint: m.hintTtl,
  };
  // Condition 4 needs an event delivered while the shadow was off: it has no
  // report row to arm from, so it is named by Zernio's own event id.
  const armByEventId: MarketingAction[] = canArm
    ? [
        {
          id: "webhook-fault-arm-event-id",
          label: m.webhookArmByEventId,
          path: "/api/admin/marketing/webhook/fault-arm",
          confirm: m.webhookArmConfirm,
          fields: [
            {
              name: "eventId",
              label: m.fieldZernioEventId,
              kind: "text",
              initial: "",
              hint: m.hintZernioEventId,
            },
            ttlField,
          ],
          describe: describeArm,
          body: (values) => ({
            eventId: String(values.eventId ?? "").trim(),
            expectedGeneration,
            ttlMinutes: Number(values.ttlMinutes),
          }),
        },
      ]
    : [];

  return (
    <div
      data-testid="marketing-webhook-staging"
    >
      <p className="text-sm font-semibold text-zinc-100">
        {m.webhookStagingTitle}
      </p>
      <p className="mt-1 text-xs text-zinc-500">{m.webhookStagingNote}</p>
      <MarketingActionRail actions={shadowToggle} section={section} onDone={onDone} m={m} />
      <p data-testid="marketing-webhook-arm-state" className="mt-3 text-xs text-zinc-300">
        {armLine}
      </p>
      <MarketingActionRail actions={armByEventId} section={section} onDone={onDone} m={m} />
      {!staging.readable ? null : !staging.reportsReadable ? (
        // A list that could not be read is not an empty one.
        <p className="mt-3 text-xs text-amber-300">{m.webhookReportsUnreadable}</p>
      ) : (
        <>
          <p className="mt-3 text-xs text-zinc-500">
            {m.webhookReportsTitle.replace("{count}", String(staging.reportLimit))}
          </p>
          {staging.shadowReports.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-400">{m.webhookReportsEmpty}</p>
          ) : (
            <div className="mt-2 grid gap-2">
              {staging.shadowReports.map((report) => (
                <article
                  key={report.id}
                  data-testid="marketing-webhook-report"
                  className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3"
                >
                  <p className="text-xs text-zinc-200">
                    {stamp(report.createdAt)} · {report.channel ?? "?"}
                    {report.accountSlug ? ` (${report.accountSlug})` : ""} · {report.eventType} →{" "}
                    {report.derivedStatus} ·{" "}
                    <span className={report.statusQueryMatch ? "text-emerald-300" : "text-amber-300"}>
                      {report.statusQueryMatch ? m.webhookMatchYes : m.webhookMatchNo}
                    </span>
                  </p>
                  <p className="mt-1 break-all font-mono text-[11px] text-zinc-500">
                    {report.eventIdDigest}
                  </p>
                  <MarketingActionRail
                    actions={
                      canArm && report.eventIdDigest !== ""
                        ? [
                            {
                              id: `webhook-fault-arm-${report.id}`,
                              label: m.webhookArmThis,
                              path: "/api/admin/marketing/webhook/fault-arm",
                              confirm: m.webhookArmConfirm,
                              fields: [
                                {
                                  name: "ttlMinutes",
                                  label: m.fieldTtlMinutes,
                                  kind: "number",
                                  initial: "30",
                                  hint: m.hintTtl,
                                },
                              ],
                              describe: (result) => {
                                const generation = (result as { generation?: unknown } | null)
                                  ?.generation;
                                return typeof generation === "number"
                                  ? m.webhookArmDone.replace("{generation}", String(generation))
                                  : null;
                              },
                              body: (values) => ({
                                eventIdDigest: report.eventIdDigest,
                                expectedGeneration,
                                ttlMinutes: Number(values.ttlMinutes),
                              }),
                            },
                          ]
                        : []
                    }
                    section={section}
                    onDone={onDone}
                    m={m}
                  />
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Registering a brand account.
 *
 * It lands in `connect_pending`: registering an account is not connecting one,
 * and the row says so until a person confirms the connection separately.
 */
function MarketingAccountCreate({
  section,
  onDone,
  m,
}: {
  section: string;
  onDone: () => void;
  m: Record<string, string>;
}) {
  const action: MarketingAction = {
    id: "account-create",
    label: m.actCreateAccount,
    path: "/api/admin/marketing/accounts",
    fields: [
      {
        name: "channel",
        label: m.fieldChannel,
        kind: "select",
        options: Object.keys(MARKETING_CHANNEL_CAPS),
      },
      {
        name: "provider",
        label: m.fieldProvider,
        kind: "select",
        options: MARKETING_PROVIDERS,
      },
      {
        name: "externalAccountRef",
        label: m.fieldExternalRef,
        kind: "text",
        hint: m.hintOptional,
      },
      {
        name: "defaultLocale",
        label: m.fieldDefaultLocale,
        kind: "select",
        options: MARKETING_LOCALES,
      },
      {
        name: "allowedLocales",
        label: m.fieldAllowedLocales,
        kind: "text",
        hint: m.hintCommaSeparated,
      },
      {
        name: "scopesDigest",
        label: m.fieldScopesDigest,
        kind: "text",
        hint: m.hintDigest,
      },
      {
        name: "policyVersion",
        label: m.fieldPolicyVersion,
        kind: "number",
        initial: "1",
      },
    ],
    body: (values) => ({
      channel: values.channel,
      provider: values.provider,
      externalAccountRef:
        values.externalAccountRef.trim() === ""
          ? null
          : values.externalAccountRef.trim(),
      defaultLocale: values.defaultLocale,
      allowedLocales: values.allowedLocales
        .split(",")
        .map((locale) => locale.trim())
        .filter((locale) => locale !== ""),
      scopesDigest: values.scopesDigest.trim(),
      policyVersion: Number(values.policyVersion),
    }),
  };

  return (
    <div
      data-testid="marketing-account-create"
      className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5"
    >
      <p className="text-[15px] font-semibold text-white">
        {m.createAccountTitle}
      </p>
      <p className="mt-1 text-xs text-zinc-500">{m.createAccountNote}</p>
      <MarketingActionRail
        actions={[action]}
        section={section}
        onDone={onDone}
        m={m}
      />
    </div>
  );
}

/**
 * A person adds a competitor A3 has not proposed, approved as it is created.
 * Its hosts become sources for market facts from the next report on.
 */
function MarketingCompetitorCreate({
  section,
  onDone,
  m,
}: {
  section: string;
  onDone: () => void;
  m: Record<string, string>;
}) {
  const action: MarketingAction = {
    id: "competitor-create",
    label: m.actCreateCompetitor,
    path: "/api/admin/marketing/competitors",
    fields: [
      { name: "competitorId", label: m.fieldCompetitorId, kind: "text", hint: m.hintCompetitorId },
      { name: "displayName", label: m.fieldDisplayName, kind: "text" },
      { name: "officialHosts", label: m.fieldOfficialHosts, kind: "text", hint: m.hintOfficialHosts },
      { name: "trackedPages", label: m.fieldTrackedPages, kind: "textarea", hint: m.hintTrackedPages },
    ],
    body: (values) => ({
      competitorId: values.competitorId.trim(),
      displayName: values.displayName,
      officialHosts: hostList(values.officialHosts),
      trackedPages: pageList(values.trackedPages),
    }),
  };

  return (
    <div
      data-testid="marketing-competitor-create"
      className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5"
    >
      <p className="text-[15px] font-semibold text-white">
        {m.createCompetitorTitle}
      </p>
      <p className="mt-1 text-xs text-zinc-500">{m.createCompetitorNote}</p>
      <MarketingActionRail actions={[action]} section={section} onDone={onDone} m={m} />
    </div>
  );
}

/**
 * Which controls a row can take, decided from the row's own state.
 *
 * The server decides every one of these again, and it is the server's answer
 * that counts. This only declines to draw a control whose sole outcome would
 * be a 409 -- offering "approve" on something already approved teaches an
 * operator that this screen's buttons are guesses.
 */
function rowActions(
  section: MarketingConsoleSection,
  row: Row,
  m: Record<string, string>
): MarketingAction[] {
  if (section === "queue") return queueActions(row, m);
  if (section === "published") return publishedActions(row, m);
  if (section === "accounts") return accountActions(row, m);
  if (section === "competitors") return competitorActions(row, m);
  if (section === "assets") return assetActions(row, m);
  return [];
}

/**
 * A competitor's decisions. Each is made against the decision this row showed
 * (`decisionAuditLogId`), so a page left open across another person's change
 * is refused rather than applied. An approval sends the name and hosts as
 * edited here: what A3 proposed is a suggestion, and the person decides what
 * counts as official.
 */
function competitorActions(row: Row, m: Record<string, string>): MarketingAction[] {
  const expected = { expectedDecisionAuditLogId: text(row.decisionAuditLogId) };
  const hosts = Array.isArray(row.officialHosts) ? (row.officialHosts as string[]) : [];
  const pages = Array.isArray(row.trackedPages) ? (row.trackedPages as string[]) : [];
  const approve: MarketingAction = {
    id: "competitor-approve",
    primary: true,
    label: m.actApproveCompetitor,
    path: COMPETITOR_DECISION(row.id),
    fields: [
      { name: "displayName", label: m.fieldDisplayName, kind: "text", initial: str(row.displayName) },
      {
        name: "officialHosts",
        label: m.fieldOfficialHosts,
        kind: "text",
        initial: hosts.join(", "),
        hint: m.hintOfficialHosts,
      },
      {
        name: "trackedPages",
        label: m.fieldTrackedPages,
        kind: "textarea",
        initial: pages.join("\n"),
        hint: m.hintTrackedPages,
      },
    ],
    body: (values) => ({
      decision: "approved",
      ...expected,
      displayName: values.displayName,
      officialHosts: hostList(values.officialHosts),
      trackedPages: pageList(values.trackedPages),
    }),
  };
  if (row.status === "proposed") {
    return [
      approve,
      {
        id: "competitor-reject",
        label: m.actRejectCompetitor,
        path: COMPETITOR_DECISION(row.id),
        body: () => ({ decision: "rejected", ...expected }),
      },
    ];
  }
  if (row.status === "approved") {
    return [
      {
        id: "competitor-retire",
        label: m.actRetireCompetitor,
        path: COMPETITOR_DECISION(row.id),
        confirm: m.confirmRetireCompetitor,
        danger: true,
        body: () => ({ decision: "retired", ...expected }),
      },
    ];
  }
  // Rejected or retired: a person may change their mind.
  return [approve];
}

/**
 * An asset's decisions, each against the decision this row showed. An
 * approval names the bytes the page showed, which the database compares: a
 * file replaced since cannot ride on this approval.
 */
function assetActions(row: Row, m: Record<string, string>): MarketingAction[] {
  const expected = { expectedDecisionAuditLogId: text(row.decisionAuditLogId) };
  const retire: MarketingAction = {
    id: "asset-retire",
    label: m.actRetireAsset,
    path: ASSET_PATH(row.id, "decision"),
    confirm: m.confirmRetireAsset,
    danger: true,
    body: () => ({ decision: "retired", ...expected }),
  };
  if (row.status === "submitted") {
    return [
      ...(row.uploadedAt
        ? [
            {
              id: "asset-approve",
              primary: true,
              label: m.actApproveAsset,
              path: ASSET_PATH(row.id, "decision"),
              confirm: m.confirmApproveAsset,
              body: () => ({ decision: "approved", ...expected, sha256: str(row.sha256) }),
            } satisfies MarketingAction,
          ]
        : []),
      retire,
    ];
  }
  return row.status === "approved" ? [retire] : [];
}

/** The two values every post writer compares against. */
const postCas = (row: Row) => ({
  expectedEnvelopeDigest: str(row.envelopeDigest),
  expectedHistoryVersion: int(row.historyVersion),
});

const legalHoldAction = (row: Row, m: Record<string, string>): MarketingAction => {
  const held = row.legalHold === true;
  return {
    id: held ? "legal-hold-release" : "legal-hold-set",
    align: "end",
    icon: "pause",
    label: held ? m.actReleaseHold : m.actSetHold,
    path: POST(row.id, "legal-hold"),
    confirm: held ? m.confirmReleaseHold : undefined,
    body: () => ({ hold: !held, expectedHistoryVersion: int(row.historyVersion) }),
  };
};

function queueActions(row: Row, m: Record<string, string>): MarketingAction[] {
  const actions: MarketingAction[] = [];
  if (row.status === "pending_approval") {
    actions.push({
      id: "approve",
      primary: true,
      icon: "check",
      label: m.actApprove,
      path: POST(row.id, "approve"),
      fields: [
        {
          name: "approvalExpiresAt",
          label: m.fieldApprovalExpires,
          kind: "datetime",
          initial: defaultApprovalExpiry(),
          hint: m.hintLocalTime,
        },
      ],
      body: (values) => ({
        ...postCas(row),
        approvalExpiresAt: instantFromLocalInput(values.approvalExpiresAt),
      }),
    });
    actions.push({
      id: "edit",
      label: m.actEdit,
      path: POST(row.id, "edit"),
      fields: [
        {
          name: "renderedText",
          label: m.fieldRenderedText,
          kind: "textarea",
          initial: str(row.renderedText),
          hint: m.hintGuardReruns,
        },
      ],
      // Only the words go up. Everything else the envelope holds -- the
      // claims, the assets, the channel and locale it was written for -- stays
      // where it is, and the route merges against the stored row: an edit is a
      // correction to the copy, not a new draft wearing the old one's history.
      // The earlier shape sent a whole envelope the console never had, so
      // every edit was a 400 against the strict schema.
      body: (values) => ({
        ...postCas(row),
        renderedText: values.renderedText,
      }),
    });
    actions.push({
      id: "reject",
      label: m.actReject,
      path: POST(row.id, "reject"),
      confirm: m.confirmReject,
      danger: true,
      body: () => postCas(row),
    });
  }
  actions.push(legalHoldAction(row, m));
  return actions;
}

const TEMPLATE_SOURCE = new Set(["approved", "scheduled", "published", "verified"]);

/**
 * The account states in which the publisher is not taking posts.
 *
 * The same set the store's `marketingChannelWasStopped()` uses, and it has to
 * be: these are exactly the states a resume or reconnect can refuse from for a
 * backlog, so they are exactly the states where the drain that clears it must
 * be reachable.
 */
/**
 * Whether the publisher has a cap to lower on this channel.
 *
 * Read from the same table the store reads, through a guard rather than an
 * index expression: the row’s channel arrives as a `string` from a payload,
 * and indexing a closed record with it is the shape that needs a cast.
 */
const channelHasCaps = (channel: string): boolean =>
  Object.hasOwn(MARKETING_CHANNEL_CAPS, channel) &&
  MARKETING_CHANNEL_CAPS[channel as keyof typeof MARKETING_CHANNEL_CAPS] !== null;

const MARKETING_STOPPED_ACCOUNT_STATUSES = new Set([
  "paused",
  "disconnected",
  "connect_pending",
]);

function publishedActions(row: Row, m: Record<string, string>): MarketingAction[] {
  const actions: MarketingAction[] = [];
  const status = str(row.status);

  if (status === "approved") {
    actions.push({
      id: "schedule",
      primary: true,
      label: m.actSchedule,
      path: POST(row.id, "schedule"),
      fields: [
        {
          name: "scheduledAt",
          label: m.fieldScheduledAt,
          kind: "datetime",
          hint: m.hintLocalTime,
        },
      ],
      body: (values) => ({
        ...postCas(row),
        scheduledAt: instantFromLocalInput(values.scheduledAt),
      }),
    });
  }

  if (status === "failed") {
    actions.push({
      id: "requeue",
      label: m.actRequeue,
      path: POST(row.id, "requeue"),
      confirm: m.confirmRequeue,
      body: () => postCas(row),
    });
  }

  if (TEMPLATE_SOURCE.has(status) && row.reusableAsTemplate !== true) {
    actions.push({
      id: "mark-reusable",
      label: m.actMarkReusable,
      path: POST(row.id, "mark-reusable"),
      confirm: m.confirmMarkReusable,
      body: () => postCas(row),
    });
  }

  if (status === "outcome_unknown") {
    actions.push({
      id: "resolve-published",
      label: m.actResolvePublished,
      path: POST(row.id, "resolve-outcome"),
      fields: [
        { name: "externalPostId", label: m.fieldExternalPostId, kind: "text" },
        { name: "externalUrl", label: m.fieldExternalUrl, kind: "url" },
        {
          name: "evidenceRef",
          label: m.fieldEvidenceRef,
          kind: "text",
          hint: m.hintEvidence,
        },
      ],
      body: (values) => ({
        resolution: "published",
        expectedHistoryVersion: int(row.historyVersion),
        externalPostId: values.externalPostId.trim(),
        externalUrl: values.externalUrl.trim(),
        evidenceRef: values.evidenceRef.trim(),
      }),
    });
    actions.push({
      id: "resolve-failed",
      label: m.actResolveFailed,
      path: POST(row.id, "resolve-outcome"),
      danger: true,
      fields: [
        { name: "errorCode", label: m.fieldErrorCode, kind: "text" },
        {
          name: "evidenceRef",
          label: m.fieldEvidenceRef,
          kind: "text",
          hint: m.hintEvidence,
        },
      ],
      body: (values) => ({
        resolution: "failed",
        expectedHistoryVersion: int(row.historyVersion),
        errorCode: values.errorCode.trim(),
        evidenceRef: values.evidenceRef.trim(),
      }),
    });
  }

  if (status === "published" || status === "verified") {
    actions.push({
      id: "unpublish",
      label: m.actUnpublish,
      path: POST(row.id, "unpublish"),
      danger: true,
      // Both statements are the operator's, so both are boxes they tick.
      // Sending a silent `true` would be this screen saying, in their name,
      // that they had checked something they were never asked about.
      fields: [
        {
          name: "evidenceRef",
          label: m.fieldEvidenceRef,
          kind: "text",
          hint: m.hintEvidence,
        },
        {
          name: "cancellationSupported",
          label: m.fieldCancellationSupported,
          kind: "checkbox",
          hint: m.hintCancellationSupported,
        },
        {
          name: "removalConfirmed",
          label: m.fieldRemovalConfirmed,
          kind: "checkbox",
          hint: m.hintRemovalConfirmed,
        },
      ],
      body: (values) => ({
        expectedStatus: status,
        expectedHistoryVersion: int(row.historyVersion),
        expectedExternalPostId: str(row.externalPostId),
        evidenceRef: values.evidenceRef.trim(),
        cancellationSupported: values.cancellationSupported === MARKETING_CHECKED,
        removalConfirmed: values.removalConfirmed === MARKETING_CHECKED,
      }),
    });
  }

  actions.push(legalHoldAction(row, m));
  return actions;
}

function accountActions(row: Row, m: Record<string, string>): MarketingAction[] {
  const actions: MarketingAction[] = [];
  const status = str(row.status);
  const generation = int(row.connectionGeneration);
  const identityCas = {
    expectedScopesDigest: str(row.scopesDigest),
    expectedPolicyVersion: int(row.policyVersion),
    expectedGraduationEpoch: int(row.graduationEpoch),
  };

  if (status === "connect_pending") {
    actions.push({
      id: "confirm-connection",
      primary: true,
      label: m.actConfirmConnection,
      path: ACCOUNT(row.id, "confirm-connection"),
      body: () => ({ expectedConnectionGeneration: generation }),
    });
  }

  if (status === "disconnected") {
    actions.push({
      id: "reconnect",
      label: m.actReconnect,
      path: ACCOUNT(row.id, "reconnect"),
      body: () => ({ expectedConnectionGeneration: generation }),
    });
  }

  if (status === "approval_mode" || status === "autonomous_mode") {
    actions.push({
      id: "pause",
      label: m.actPause,
      path: ACCOUNT(row.id, "pause"),
      danger: true,
      fields: [
        {
          name: "reasonCode",
          label: m.fieldReasonCode,
          kind: "select",
          options: MARKETING_PAUSE_REASON_CODES,
        },
      ],
      body: (values) => ({ expectedStatus: status, reasonCode: values.reasonCode }),
    });
    actions.push({
      id: "scopes",
      label: m.actChangeScopes,
      path: ACCOUNT(row.id, "scopes"),
      fields: [
        {
          name: "scopesDigest",
          label: m.fieldScopesDigest,
          kind: "text",
          hint: m.hintIdentityChange,
        },
      ],
      body: (values) => ({ ...identityCas, scopesDigest: values.scopesDigest.trim() }),
    });
    actions.push({
      id: "policy-version",
      label: m.actChangePolicyVersion,
      path: ACCOUNT(row.id, "policy-version"),
      fields: [
        {
          name: "policyVersion",
          label: m.fieldPolicyVersion,
          kind: "number",
          initial: String(int(row.policyVersion) + 1),
          hint: m.hintIdentityChange,
        },
      ],
      body: (values) => ({ ...identityCas, policyVersion: Number(values.policyVersion) }),
    });
  }

  if (status === "paused") {
    actions.push({
      id: "resume-approval",
      label: m.actResumeApproval,
      path: ACCOUNT(row.id, "resume"),
      body: () => ({ mode: "approval" }),
    });
    if (row.pausedFromMode === "autonomous_mode") {
      actions.push({
        id: "resume-autonomous",
        label: m.actResumeAutonomous,
        path: ACCOUNT(row.id, "resume"),
        fields: [
          {
            name: "reasonCode",
            label: m.fieldReasonCode,
            kind: "select",
            options: MARKETING_RESUME_REASON_CODES,
          },
        ],
        body: (values) => ({ mode: "autonomous", reasonCode: values.reasonCode }),
      });
    }
  }

  // Wherever a resume or a reconnect can refuse for a backlog, the drain that
  // clears it has to be reachable. Offered without first knowing a backlog
  // exists, because the console does not count due posts -- a control that
  // appeared only once one was visible would be missing exactly when the
  // refusals start. A disconnected account with a backlog and no drain had no
  // way back at all: there is no edge from `disconnected` into `paused`.
  if (MARKETING_STOPPED_ACCOUNT_STATUSES.has(status)) {
    actions.push({
      id: "drain",
      label: m.actDrain,
      path: ACCOUNT(row.id, "drain"),
      body: () => ({}),
      describe: (result) => {
        const value = result as
          | { expiredPostIds?: unknown; remaining?: unknown }
          | null;
        const expired = Array.isArray(value?.expiredPostIds)
          ? value.expiredPostIds.length
          : 0;
        return (value?.remaining === true ? m.drainMore : m.drainDone).replace(
          "{count}",
          String(expired)
        );
      },
    });
  }

  if (status !== "disconnected") {
    actions.push({
      id: "lower-caps",
      label: m.actLowerCaps,
      path: ACCOUNT(row.id, "caps"),
      // A manual channel has no publisher cap to override, so the writer
      // answers `manual_channel_has_no_caps` every time. The channel is in
      // the payload, so the screen can say so before the click instead of
      // after it.
      unavailable: channelHasCaps(str(row.channel))
        ? undefined
        : m.capsManualChannel,
      fields: [
        {
          name: "dailyCapOverride",
          label: m.fieldDailyCap,
          kind: "number",
          initial:
            typeof row.dailyCapOverride === "number" ? String(row.dailyCapOverride) : "",
          hint: m.hintCapEmpty,
        },
        {
          name: "weeklyCapOverride",
          label: m.fieldWeeklyCap,
          kind: "number",
          initial:
            typeof row.weeklyCapOverride === "number" ? String(row.weeklyCapOverride) : "",
          hint: m.hintCapEmpty,
        },
      ],
      body: (values) => ({
        dailyCapOverride: capOverride(values.dailyCapOverride),
        weeklyCapOverride: capOverride(values.weeklyCapOverride),
      }),
    });
    actions.push({
      id: "disconnect",
      label: m.actDisconnect,
      path: ACCOUNT(row.id, "disconnect"),
      confirm: m.confirmDisconnect,
      danger: true,
      body: () => ({
        expectedStatus: status,
        expectedConnectionGeneration: generation,
      }),
    });
  }

  return actions;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-0.5 truncate text-[13px] text-zinc-200">{value}</p>
    </div>
  );
}

/** The line that says whose row this is, with its state on the right. */
function RowHeading({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-semibold text-zinc-100">{title}</span>
        {detail ? <span className="shrink-0 font-mono text-xs text-zinc-500">{detail}</span> : null}
      </p>
      <span className="flex shrink-0 flex-wrap items-center gap-1.5">{children}</span>
    </div>
  );
}

const CHANNEL_NAMES: Record<string, string> = {
  linkedin: "LinkedIn",
  x: "X",
  instagram: "Instagram",
  tiktok: "TikTok",
  threads: "Threads",
  facebook: "Facebook",
  youtube: "YouTube",
  bluesky: "Bluesky",
};
const channelName = (value: unknown) => CHANNEL_NAMES[str(value)] ?? str(value);

const guardWord = (decision: unknown, m: Record<string, string>) => {
  const tone = guardTone(decision);
  return tone === "success" ? m.guardPass : tone === "danger" ? m.guardBlock : m.guardReview;
};

const guardTone = (decision: unknown): "success" | "warning" | "danger" | "neutral" => {
  const value = typeof decision === "string" ? decision : "";
  if (/pass|allow|approve/u.test(value)) return "success";
  if (/block|reject|deny|refuse/u.test(value)) return "danger";
  return value ? "warning" : "neutral";
};

function MarketingRow({
  section,
  row,
  now,
  m,
}: {
  section: MarketingConsoleSection;
  row: Row;
  /** When the page was read: relative times are measured from here. */
  now: string;
  m: Record<string, string>;
}) {
  if (section === "queue") {
    const codes = ((row.guardCodes as string[]) ?? []).filter(Boolean);
    const guard = guardTone(row.guardDecision);
    return (
      <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-md border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-xs font-medium text-zinc-200">
              {channelName(row.channel)}
            </span>
            <span className="truncate text-[13px] font-semibold text-zinc-100">{str(row.accountSlug)}</span>
            <span className="shrink-0 font-mono text-[11px] uppercase text-zinc-500">{str(row.locale)}</span>
          </p>
          <span className="flex shrink-0 flex-wrap items-center gap-1.5">
            {row.status === "pending_approval" ? null : <StatusTag status={row.status} m={m} />}
            {row.legalHold === true ? <MarketingTag tone="warning">{m.legalHeld}</MarketingTag> : null}
            <MarketingTag tone={guard}>
              {guard === "success" ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
              Guard {guardWord(row.guardDecision, m)}
              {codes.length > 0 ? ` · ${codes.join(" · ")}` : ""}
            </MarketingTag>
          </span>
        </div>
        <p className="mt-3 whitespace-pre-line text-sm leading-6 text-zinc-100">{text(row.excerpt) ?? m.none}</p>
        <p className="mt-3 text-xs text-zinc-500" title={`${stamp(row.createdAt) ?? ""} UTC`}>
          {m.queueMeta
            .replace("{created}", relative(row.createdAt, now, m) ?? m.none)
            .replace("{expires}", relative(row.approvalExpiresAt, now, m) ?? m.none)
            .replace("{claims}", typeof row.claimCount === "number" ? String(row.claimCount) : m.none)}
        </p>
      </>
    );
  }

  if (section === "published") {
    return (
      <>
        <RowHeading title={str(row.accountSlug)} detail={`${str(row.channel)} · ${String(row.mode)}`}>
          {row.legalHold === true ? <MarketingTag tone="warning">{m.legalHeld}</MarketingTag> : null}
          <StatusTag status={row.status} m={m} />
        </RowHeading>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          <Field label={m.colAttempts} value={String(row.publishAttempt ?? 0)} />
          <Field label={m.colUrl} value={text(row.externalUrl) ?? m.none} />
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
      <>
        <RowHeading title={str(row.accountSlug)} detail={`${str(row.channel)} · ${str(row.provider)}`}>
          <StatusTag status={row.status} m={m} />
        </RowHeading>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          <Field
            label={m.colIdentity}
            value={`v${row.policyVersion} / e${row.graduationEpoch} / c${row.connectionGeneration}`}
          />
        </div>
      </>
    );
  }

  if (section === "competitors") {
    const hosts = Array.isArray(row.officialHosts) ? (row.officialHosts as string[]) : [];
    const evidence = Array.isArray(row.evidenceUrls) ? (row.evidenceUrls as string[]) : [];
    return (
      <>
        <RowHeading title={str(row.displayName)} detail={str(row.id)}>
          <span className="text-xs text-zinc-500">{str(row.proposedBy)}</span>
          <StatusTag status={row.status} m={m} />
        </RowHeading>
        {hosts.length > 0 ? (
          <p className="mt-3 flex flex-wrap gap-1.5" aria-label={m.colHosts}>
            {hosts.map((host) => (
              <span
                key={host}
                className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-0.5 font-mono text-xs text-zinc-300"
              >
                {host}
              </span>
            ))}
          </p>
        ) : null}
        {/*
          A3's own words are text. Its evidence is the web-search pages a
          person opens to judge the proposal (S3f-R5c): https only, a new tab,
          no referrer and no endorsement.
        */}
        {text(row.rationale) ? (
          <p className="mt-3 text-sm leading-6 text-zinc-300">{text(row.rationale)}</p>
        ) : null}
        <p className="mt-3 text-xs text-zinc-500">
          {m.colDecided} {stamp(row.decidedAt) ?? m.none}
        </p>
        {Array.isArray(row.trackedPages) && row.trackedPages.length > 0 ? (
          <p className="mt-1 break-all text-xs text-zinc-500">
            {m.colTrackedPages} {(row.trackedPages as string[]).join(" / ")}
          </p>
        ) : null}
        {evidence.length > 0 ? (
          <p className="mt-1 break-all text-xs text-zinc-500">
            {m.colEvidence}{" "}
            {evidence.map((url, index) => (
              <span key={`${index}:${url}`}>
                {index > 0 ? " / " : null}
                {url.startsWith("https://") ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-zinc-300 underline underline-offset-2 hover:text-white"
                    data-testid="marketing-competitor-evidence-link"
                  >
                    {url}
                  </a>
                ) : (
                  url
                )}
              </span>
            ))}
          </p>
        ) : null}
      </>
    );
  }

  if (section === "assets") {
    const disclosure = (row.disclosure ?? {}) as Record<string, string>;
    const alt = (row.alt ?? {}) as Record<string, string>;
    const size = int(row.bytes);
    return (
      <>
        <RowHeading title={str(row.id)} detail={`${str(row.kind)} · ${str(row.provenance)}`}>
          <StatusTag status={row.status} m={m} />
        </RowHeading>
        <p className="mt-3 text-xs text-zinc-500">
          {m.colFile} {str(row.contentType)} · {(size / (1024 * 1024)).toFixed(1)} MB
          {row.durationSeconds ? ` · ${int(row.durationSeconds)}s` : ""} · {str(row.sha256).slice(0, 12)}…
        </p>
        <p className="mt-1 break-all text-xs text-zinc-500">
          {m.colChannels}{" "}
          {Object.entries(disclosure)
            .map(([channel, decision]) => `${channelName(channel)} (${decision})`)
            .join(" / ")}
        </p>
        {Object.entries(alt).map(([locale, value]) => (
          <p key={locale} className="mt-1 text-sm leading-6 text-zinc-300">
            <span className="mr-2 text-xs text-zinc-500">{locale}</span>
            {value}
          </p>
        ))}
        <p className="mt-2 text-xs">
          {row.uploadedAt ? (
            <a
              href={ASSET_PATH(row.id, "preview")}
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-300 underline underline-offset-2 hover:text-white"
              data-testid="marketing-asset-preview-link"
            >
              {m.colPreview}
            </a>
          ) : (
            <span className="text-zinc-500">{m.notUploaded}</span>
          )}
        </p>
      </>
    );
  }

  return (
    <>
      <RowHeading title={String(row.kind)} detail={String(row.sourceVersion)} />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field
          label={m.colPeriod}
          value={`${stamp(row.periodStart) ?? m.none} - ${stamp(row.periodEnd) ?? m.none}`}
        />
        <Field label={m.colCreated} value={stamp(row.createdAt) ?? m.none} />
      </div>
    </>
  );
}
