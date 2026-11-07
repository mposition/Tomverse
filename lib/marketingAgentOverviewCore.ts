import { formatAestDate } from "@/lib/adminUiCore";

/**
 * What the Marketing agent's Overview tab shows beyond the console's own
 * overview strip: how many posts were written each day, what is scheduled and
 * the generator's latest runs. Each part is read on its own and is null when
 * it could not be read, which the screen says in words and never draws as none
 * (docs/ui-contracts/admin-console-ia.md, rule 8).
 *
 * Kept free of `prisma` and of React so the screen, the loader and the tests
 * read the same shapes and the same arithmetic.
 */
export type MarketingWeekPosts = {
  /** Seven Brisbane days, oldest first, the last one being today. */
  days: { date: string; count: number }[];
  /** The seven days' total. */
  total: number;
  /** The seven days before those. */
  previousTotal: number;
};

export type MarketingScheduledPost = {
  id: string;
  channel: string;
  accountSlug: string;
  locale: string;
  scheduledAt: string;
  excerpt: string | null;
};

export type MarketingRecentRun = {
  id: string;
  at: string;
  calls: number;
  countedMicroUsd: number;
  /** Calls that are neither settled nor released: money that may have been spent. */
  unsettled: number;
};

export type MarketingAgentOverview = {
  week: MarketingWeekPosts | null;
  scheduled: MarketingScheduledPost[] | null;
  runs: MarketingRecentRun[] | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bucket post creation times into Brisbane days. Brisbane has no daylight
 * saving, so stepping back whole days from `now` lands on the same wall-clock
 * time each day and the bucket names never skip or repeat.
 */
export function marketingWeekPosts(createdAt: readonly Date[], now: Date): MarketingWeekPosts {
  const keys: string[] = [];
  for (let back = 13; back >= 0; back -= 1) {
    keys.push(formatAestDate(new Date(now.getTime() - back * DAY_MS)) ?? "");
  }
  const counts = new Map(keys.map((key) => [key, 0]));
  for (const at of createdAt) {
    const key = formatAestDate(at);
    if (key !== null && counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const days = keys.slice(7).map((date) => ({ date, count: counts.get(date) ?? 0 }));
  const previousTotal = keys.slice(0, 7).reduce((sum, key) => sum + (counts.get(key) ?? 0), 0);
  return { days, total: days.reduce((sum, day) => sum + day.count, 0), previousTotal };
}

/** The first line of a post's words, shortened for a list. */
export function marketingExcerptLine(envelope: unknown, limit = 90): string | null {
  if (!envelope || typeof envelope !== "object") return null;
  const value = (envelope as { renderedText?: unknown }).renderedText;
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
