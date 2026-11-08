/**
 * One approved post a day per account (owner request 2026-11-08).
 *
 * The console's "publish all now" gives every approved post the same time, so
 * the publisher picks them up run after run and defers all but one per account
 * with `daily_cap_reached`: nobody can tell what goes out when. This plans the
 * same posts one day apart instead. It only chooses times. Each time is still
 * sent through the post's own schedule route, with its own checks and audit
 * entry, and the publisher's caps, kill switch and digest checks are unchanged.
 *
 * Pure and deterministic: no clock, no network. The caller passes `now`.
 *
 * Days are counted the way the publisher counts them. A post spends the UTC
 * date it is claimed on (`MarketingPost.slotDate`, lib/marketingStore.ts), so a
 * day is "taken" in UTC terms; the time of day is chosen in the account's
 * market (docs/policy/marketing-automation.md §7: local 09:00-20:00).
 */
import type { MarketingLocale } from "@/lib/marketingAutomationSchema";

/** The market each account language posts to. `en` is the operator's own market. */
export const MARKETING_LOCALE_TIME_ZONES: Readonly<Record<MarketingLocale, string>> = {
  en: "Australia/Brisbane",
  ko: "Asia/Seoul",
  "zh-Hant": "Asia/Taipei",
  "zh-Hans": "Asia/Shanghai",
};

/** The policy's posting window, in the market's local hours: [start, end). */
export const MARKETING_LOCAL_POSTING_WINDOW = { startHour: 9, endHour: 20 } as const;

/** The fixed local time a planned day posts at. */
export const MARKETING_DAILY_SLOT_HOUR = 10;

/**
 * How far ahead of `now` the first time must be. The schedule route refuses a
 * time that is not in the future at the database's clock, and the person still
 * has a confirmation to read before the requests go.
 */
export const MARKETING_DAILY_SCHEDULE_LEAD_MS = 5 * 60 * 1000;

/** No account is planned further out than this, whatever its approvals say. */
const MAX_PLAN_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export type DailySchedulePost = {
  readonly id: string;
  readonly status: string;
  readonly provider: string;
  /** The account (MarketingChannel.id). */
  readonly channelId: string;
  /** The account's language: MarketingChannel.defaultLocale. */
  readonly accountLocale: string;
  readonly approvedAt: string | null;
  readonly approvalExpiresAt: string | null;
  /** The account's daily cap in force; null for an account the publisher does not post to. */
  readonly dailyCap: number | null;
};

/**
 * A day an account has already spent or promised.
 *
 * `slotDay` is a claim the publisher made (YYYY-MM-DD, UTC). Without one, a
 * `scheduledAt` is a post that will spend a day when it is claimed.
 */
export type DailyScheduleTakenSlot = {
  readonly channelId: string;
  readonly slotDay: string | null;
  readonly scheduledAt: string | null;
};

export type DailyScheduleSlot = {
  readonly postId: string;
  readonly channelId: string;
  readonly scheduledAt: string;
  /** The market's calendar date, YYYY-MM-DD. */
  readonly localDay: string;
};

export type DailyScheduleAccountPlan = {
  readonly channelId: string;
  readonly timeZone: string;
  readonly slots: readonly DailyScheduleSlot[];
  /** Posts whose turn would come only after their approval expires. */
  readonly expired: readonly string[];
};

export type DailySchedulePlan = {
  /** Every planned request, account by account, oldest approval first. */
  readonly slots: readonly DailyScheduleSlot[];
  readonly accounts: readonly DailyScheduleAccountPlan[];
  /** Post ids left unscheduled because their turn falls after their approval expires. */
  readonly expired: readonly string[];
};

/** The account's market time zone; an unknown language falls back to the operator's market. */
export const marketingTimeZoneFor = (locale: string): string =>
  Object.hasOwn(MARKETING_LOCALE_TIME_ZONES, locale)
    ? MARKETING_LOCALE_TIME_ZONES[locale as MarketingLocale]
    : MARKETING_LOCALE_TIME_ZONES.en;

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

/** The wall clock in `timeZone` at `instant`. */
export const localParts = (instant: number, timeZone: string): LocalParts => {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
  };
};

const pad = (value: number) => String(value).padStart(2, "0");
const ymd = (parts: { year: number; month: number; day: number }) =>
  `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;

/**
 * The instant that reads `hour`:00 on the given calendar date in `timeZone`.
 * Two passes, so a date whose offset differs from the first guess's still lands
 * on the right wall clock.
 */
export const zonedInstant = (
  date: { year: number; month: number; day: number },
  hour: number,
  timeZone: string
): number => {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, 0, 0, 0);
  let instant = wall;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = localParts(instant, timeZone);
    const seenWall = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0, 0);
    instant += wall - seenWall;
  }
  return instant;
};

/** The calendar date `days` after `date`, with no time zone involved. */
const addDays = (date: { year: number; month: number; day: number }, days: number) => {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
};

const utcDay = (instant: number) => new Date(instant).toISOString().slice(0, 10);

const time = (iso: string | null): number | null => {
  if (iso === null) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
};

/**
 * How many posts each UTC day already holds for one account.
 *
 * A post scheduled for a time already past has not gone out yet: the publisher
 * will claim it on the next day with room, so it is counted there, one after
 * another from today, the way the publisher would take them.
 */
const takenDays = (
  taken: readonly DailyScheduleTakenSlot[],
  cap: number,
  now: number
): Map<string, number> => {
  const counts = new Map<string, number>();
  const bump = (day: string) => counts.set(day, (counts.get(day) ?? 0) + 1);
  const overdue: number[] = [];
  for (const slot of taken) {
    if (slot.slotDay !== null) {
      bump(slot.slotDay.slice(0, 10));
      continue;
    }
    const at = time(slot.scheduledAt);
    if (at === null) continue;
    if (at > now) bump(utcDay(at));
    else overdue.push(at);
  }
  overdue.sort((a, b) => a - b);
  let cursor = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  for (let index = 0; index < overdue.length; ) {
    const day = utcDay(cursor);
    if ((counts.get(day) ?? 0) < cap) {
      bump(day);
      index += 1;
    } else {
      cursor += DAY_MS;
    }
  }
  return counts;
};

const approvalOrder = (a: DailySchedulePost, b: DailySchedulePost) => {
  const at = time(a.approvedAt) ?? Number.POSITIVE_INFINITY;
  const bt = time(b.approvedAt) ?? Number.POSITIVE_INFINITY;
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** The approved posts the publisher would carry: not hand-posted, and on an account it posts to. */
export const dailySchedulablePosts = (
  posts: readonly DailySchedulePost[]
): DailySchedulePost[] =>
  posts.filter(
    (post) =>
      post.status === "approved" &&
      post.provider !== "manual" &&
      typeof post.dailyCap === "number" &&
      post.dailyCap > 0
  );

/**
 * The plan: for each account, its approved posts in approval order, one a day
 * at the market's local 10:00, starting today.
 *
 * - Today is used only while the account's cap for today is not reached, and
 *   only while a time at least `MARKETING_DAILY_SCHEDULE_LEAD_MS` away is still
 *   inside today's posting window (late in the day, today's slot becomes "as
 *   soon as possible" rather than the 10:00 that has passed).
 * - A later day that already holds a post is full: a scheduled post is never
 *   moved, and the plan goes around it.
 * - A post whose turn would come after its approval expires is not scheduled.
 *   The plan never extends an approval; the person decides whether to approve
 *   again with a longer expiry. The day stays free for the next post.
 */
export function planDailyMarketingSchedule(input: {
  readonly posts: readonly DailySchedulePost[];
  readonly taken: readonly DailyScheduleTakenSlot[];
  readonly now: number;
}): DailySchedulePlan {
  const { now } = input;
  const byAccount = new Map<string, DailySchedulePost[]>();
  for (const post of dailySchedulablePosts(input.posts).sort(approvalOrder)) {
    const list = byAccount.get(post.channelId) ?? [];
    list.push(post);
    byAccount.set(post.channelId, list);
  }

  const accounts: DailyScheduleAccountPlan[] = [];
  for (const [channelId, posts] of byAccount) {
    const cap = posts[0].dailyCap as number;
    const timeZone = marketingTimeZoneFor(posts[0].accountLocale);
    const counts = takenDays(
      input.taken.filter((slot) => slot.channelId === channelId),
      cap,
      now
    );
    const today = localParts(now, timeZone);
    const earliest = Math.ceil((now + MARKETING_DAILY_SCHEDULE_LEAD_MS) / MINUTE_MS) * MINUTE_MS;

    const slots: DailyScheduleSlot[] = [];
    const expired: string[] = [];
    let offset = 0;
    for (const post of posts) {
      let planned: DailyScheduleSlot | null = null;
      while (planned === null && offset < MAX_PLAN_DAYS) {
        const date = addDays(today, offset);
        let at = zonedInstant(date, MARKETING_DAILY_SLOT_HOUR, timeZone);
        if (at < earliest) at = earliest;
        const local = localParts(at, timeZone);
        const inWindow =
          ymd(local) === ymd(date) &&
          local.hour >= MARKETING_LOCAL_POSTING_WINDOW.startHour &&
          local.hour < MARKETING_LOCAL_POSTING_WINDOW.endHour;
        // Today may share the cap with what already went out; any later day
        // that already holds a post is left to that post.
        const limit = offset === 0 ? cap : 1;
        if (inWindow && (counts.get(utcDay(at)) ?? 0) < limit) {
          planned = { postId: post.id, channelId, scheduledAt: new Date(at).toISOString(), localDay: ymd(date) };
        } else {
          offset += 1;
        }
      }
      if (planned === null) {
        expired.push(post.id);
        continue;
      }
      const expiresAt = time(post.approvalExpiresAt);
      if (expiresAt !== null && Date.parse(planned.scheduledAt) >= expiresAt) {
        // Not this post's day after all; the next post may still fit it.
        expired.push(post.id);
        continue;
      }
      slots.push(planned);
      const spent = utcDay(Date.parse(planned.scheduledAt));
      counts.set(spent, (counts.get(spent) ?? 0) + 1);
      offset += 1;
    }
    accounts.push({ channelId, timeZone, slots, expired });
  }

  return {
    slots: accounts.flatMap((account) => account.slots),
    accounts,
    expired: accounts.flatMap((account) => account.expired),
  };
}
