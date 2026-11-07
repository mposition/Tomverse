/**
 * What both Admin Scout panels draw the same way: the switch-model-cap state,
 * the chip classes, numbers and times. Dark classes only, like every Admin
 * component; Light is the generated remap
 * (app/(site)/(application)/admin/admin-theme.css).
 */
import { formatAestDate } from "@/lib/adminUiCore";
import type { ScoutConsoleView } from "@/lib/productResearchScoutConsoleRead";

const AEST_ZONE = "Australia/Brisbane";

export const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);

/** On, collecting without judging (no model or a zero cap), or switched off in this environment. */
export type ScoutState = "on" | "judging_off" | "off";

export const scoutState = (view: Pick<ScoutConsoleView, "enabled" | "settings">): ScoutState =>
  !view.enabled ? "off" : !view.settings.modelId || view.settings.dailyCallCap === 0 ? "judging_off" : "on";

export const CHIP = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium";

export const NEUTRAL_CHIP = "border-zinc-700 bg-zinc-800/60 text-zinc-300";

export const SEVERITY_CHIP: Readonly<Record<string, string>> = {
  high: "border-red-500/40 bg-red-500/10 text-red-300",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  low: NEUTRAL_CHIP,
};

export const STATE_CHIP: Readonly<Record<ScoutState, string>> = {
  on: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  judging_off: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  off: NEUTRAL_CHIP,
};

export const SEVERITY_RANK: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 };

const dateLocale = (locale: string) => (locale === "ko" ? "ko-KR" : "en-AU");

/** Token counts as 412K, the same in both locales. */
export const compactNumber = (value: number) =>
  new Intl.NumberFormat("en-AU", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export const fullNumber = (value: number, locale: string) => value.toLocaleString(dateLocale(locale));

/**
 * A time in AEST (Brisbane): "Today 21:44", "Tomorrow 04:00", or the date for
 * any other day. The server and the browser format in the same zone, and the
 * `<time>` that shows it carries the exact instant in `dateTime`.
 */
export function localTime(
  iso: string,
  locale: string,
  days: { readonly today: string; readonly tomorrow: string } | null,
  now: Date = new Date(),
): string {
  const date = new Date(iso);
  const time = new Intl.DateTimeFormat(dateLocale(locale), { timeZone: AEST_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  if (days === null) return time;
  const key = (value: Date) => formatAestDate(value);
  // Brisbane has no daylight saving, so a day is always 24 hours.
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const day =
    key(date) === key(now)
      ? days.today
      : key(date) === key(tomorrow)
        ? days.tomorrow
        : new Intl.DateTimeFormat(dateLocale(locale), { timeZone: AEST_ZONE, month: "numeric", day: "numeric" }).format(date);
  return `${day} ${time}`;
}

/**
 * How many suggestions "select the next batch" picks. AMUX gets through ideas
 * slowly, each can start paid work, and one it has not reached within seven days
 * is dropped (lib/amux/ideaRetentionCore.ts), so a larger batch would only lose ideas.
 */
export const SCOUT_SEND_BATCH = 10;

/** Sends are spaced so a long selection stays inside the send route's five a minute. */
export const SCOUT_SEND_SPACING_MS = 13_000;

/** The next batch to send: most severe first, and oldest first within a severity, so nothing waits for ever. */
export function nextScoutSendBatch<T extends { readonly id: string; readonly severity: string; readonly createdAt: string }>(
  rows: readonly T[],
  count: number = SCOUT_SEND_BATCH,
): string[] {
  return [...rows]
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || a.createdAt.localeCompare(b.createdAt))
    .slice(0, count)
    .map((row) => row.id);
}
