/**
 * Which date bucket a conversation row belongs to.
 *
 * The sidebar used to be one flat list ordered by `updatedAt` with pinned rows
 * hoisted to the top, and a row that said the model instead of the time. The
 * axis people actually scan a chat list by is *when*, and this is the only
 * module that decides it.
 *
 * ## What "when" means here
 *
 * **Last activity, not creation.** The list is ordered by `updatedAt`
 * (`app/api/conversations/route.ts`), so grouping by anything else would print
 * headers a reader could not reconcile with the order beneath them: a
 * conversation created three weeks ago and answered this morning belongs under
 * 오늘 where its position already puts it.
 *
 * **Calendar days in the reader's own zone**, never a fixed number of hours.
 * "Yesterday" at 00:30 means the calendar day before, which may be forty
 * minutes ago; a 24-hour window would call that "today" and be wrong in the
 * only way a date header can be wrong. DST is handled by asking the calendar
 * rather than doing arithmetic on milliseconds.
 *
 * **A row with no timestamp is not guessed at.** A guest row written before
 * this field existed, or an image conversation added optimistically before the
 * server answers, has no activity to place. It goes to `older` -- the one
 * bucket that claims nothing -- rather than to 오늘, which would say something
 * false about it and put it above rows that really did happen today.
 *
 * Pinned rows are not bucketed at all: `partitionConversationRows` lifts them
 * out first, because the whole point of pinning is to be above the dates.
 */

export const CONVERSATION_DATE_BUCKETS = [
  "today",
  "yesterday",
  "lastSevenDays",
  "older",
] as const;

export type ConversationDateBucket = (typeof CONVERSATION_DATE_BUCKETS)[number];

/** A row as this module needs it: an id, a pin, and a last-activity stamp. */
export type GroupableConversation = {
  id: string;
  updatedAt?: string | null;
  pinned?: boolean;
};

const DAY_KEY_FORMAT_CACHE = new Map<string, Intl.DateTimeFormat>();

const dayKeyFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const cached = DAY_KEY_FORMAT_CACHE.get(timeZone);
  if (cached) return cached;
  // `en-CA` gives YYYY-MM-DD, which sorts and compares as a string. The locale
  // is an implementation detail of the comparison and never reaches the screen.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  DAY_KEY_FORMAT_CACHE.set(timeZone, formatter);
  return formatter;
};

/** The calendar day a moment falls on, in the reader's zone. */
const dayKey = (value: Date, timeZone: string): string =>
  dayKeyFormatter(timeZone).format(value);

const addDays = (value: Date, days: number): Date =>
  new Date(value.getTime() + days * 24 * 60 * 60 * 1000);

export type BucketOptions = {
  /** Defaults to now; passed in so tests and a midnight re-render agree. */
  now?: Date;
  /** IANA zone. Defaults to the runtime's, which is the reader's own. */
  timeZone?: string;
};

const resolveTimeZone = (timeZone?: string): string => {
  if (timeZone) return timeZone;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/**
 * Which bucket a single row belongs to.
 *
 * An unparseable or missing stamp is `older`, for the reason in the module
 * comment: the list may not invent a date for a row that has none.
 */
export const conversationDateBucket = (
  updatedAt: string | null | undefined,
  options: BucketOptions = {}
): ConversationDateBucket => {
  if (!updatedAt) return "older";
  const stamp = new Date(updatedAt);
  if (Number.isNaN(stamp.getTime())) return "older";

  const now = options.now ?? new Date();
  const timeZone = resolveTimeZone(options.timeZone);
  const stampDay = dayKey(stamp, timeZone);
  const todayDay = dayKey(now, timeZone);
  if (stampDay === todayDay) return "today";
  if (stampDay === dayKey(addDays(now, -1), timeZone)) return "yesterday";
  // A future stamp -- a clock that is behind, a row written by another device
  // -- reads as today rather than as "older", which would bury it under rows it
  // is newer than.
  if (stampDay > todayDay) return "today";
  for (let back = 2; back <= 7; back += 1) {
    if (stampDay === dayKey(addDays(now, -back), timeZone)) return "lastSevenDays";
  }
  return "older";
};

export type ConversationRowGroup<T> = {
  bucket: ConversationDateBucket;
  conversations: T[];
};

export type PartitionedConversationRows<T> = {
  pinned: T[];
  groups: ConversationRowGroup<T>[];
};

/**
 * Pinned rows first, then one group per non-empty bucket in a fixed order.
 *
 * Order *inside* each group is the caller's -- the list already arrives
 * newest-first, and this module does not re-sort it. A pinned row appears once,
 * in the pinned section only: printing it again under its date would make the
 * same conversation two rows and the count in the pinned header a lie.
 */
export const partitionConversationRows = <T extends GroupableConversation>(
  conversations: readonly T[],
  options: BucketOptions = {}
): PartitionedConversationRows<T> => {
  const pinned: T[] = [];
  const byBucket = new Map<ConversationDateBucket, T[]>();

  for (const conversation of conversations) {
    if (conversation.pinned) {
      pinned.push(conversation);
      continue;
    }
    const bucket = conversationDateBucket(conversation.updatedAt, options);
    const existing = byBucket.get(bucket);
    if (existing) existing.push(conversation);
    else byBucket.set(bucket, [conversation]);
  }

  return {
    pinned,
    groups: CONVERSATION_DATE_BUCKETS.flatMap((bucket) => {
      const rows = byBucket.get(bucket);
      return rows && rows.length > 0 ? [{ bucket, conversations: rows }] : [];
    }),
  };
};

/**
 * When the next calendar day starts, so a list left open overnight re-groups.
 *
 * Returned as a delay rather than a moment: the caller sets a timer, and a
 * timer wants milliseconds. Clamped to at least a second so a clock that
 * lands exactly on midnight cannot spin.
 */
export const millisecondsUntilNextDay = (options: BucketOptions = {}): number => {
  const now = options.now ?? new Date();
  const timeZone = resolveTimeZone(options.timeZone);
  // The reader's wall clock, which is the only clock the headers follow.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  // `hour12: false` still renders midnight as 24 in some locales.
  const hour = part("hour") % 24;
  const secondsSinceMidnight = hour * 3600 + part("minute") * 60 + part("second");
  const remaining = 24 * 3600 - secondsSinceMidnight;
  // A second past the turn, never a second before it: a timer that fires early
  // re-renders the same grouping and then sits there until the next tick.
  //
  // On a DST day the real distance is an hour more or less than this. The
  // caller re-reads the clock when the timer fires and schedules again, so the
  // worst case is one extra re-render, not a header that stays wrong.
  return Math.max(1_000, remaining * 1000 + 1_000);
};
