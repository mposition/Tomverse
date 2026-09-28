/**
 * When Korea's two-yearly consent notice falls due, given the anchors.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.7.
 * The rows come from `lib/biennialConsentNoticeReadiness.ts`; this decides.
 *
 * Pure, and separate from the query for the usual reason: the arithmetic is
 * what has to be right, and a date two years from a date is not as simple as it
 * sounds. Section 7.7 fixes the two awkward cases -- the calendar is
 * Asia/Seoul, and a consent given on 29 February is due on 28 February.
 */

/** 제50조제8항: every two years. */
export const BIENNIAL_NOTICE_INTERVAL_MONTHS = 24;

/** Section 7.7: warn sixty days before the earliest deadline. */
export const BIENNIAL_NOTICE_WARN_DAYS = 60;

export type BiennialAnchor = {
  userId: string;
  anchoredAt: Date;
  /** `consent` where they actually consented; the deemed signup date otherwise. */
  source: "consent" | "signup_date_deemed";
};

/**
 * A deadline as it goes into a message, to the day.
 *
 * The `context` fields were already truncated so a count of one could not be
 * correlated with a consent's exact moment, and a review pointed out the
 * message itself was not -- and the message is what reaches the log, the error
 * tracker and whatever is subscribed to it. One recipient and a full timestamp
 * is that person's consent time.
 */
const onDay = (at: Date) => at.toISOString().slice(0, 10);

const DAY_MS = 86_400_000;

/**
 * The instant a notice anchored here falls due.
 *
 * Two years on in the Asia/Seoul calendar, which is the calendar the statute
 * counts in. A 29 February anchor is due on 28 February, because the target
 * year has no 29th and rolling forward to 1 March would be a day late -- and
 * late is the direction that matters.
 */
export const biennialNoticeDueAt = (anchoredAt: Date): Date => {
  // Seoul is UTC+9 all year: no daylight saving since 1988, so a fixed offset
  // is the whole conversion rather than an approximation of one.
  const seoul = new Date(anchoredAt.getTime() + 9 * 3600 * 1000);
  const year = seoul.getUTCFullYear() + BIENNIAL_NOTICE_INTERVAL_MONTHS / 12;
  const month = seoul.getUTCMonth();
  const day = seoul.getUTCDate();

  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const target = Date.UTC(
    year,
    month,
    Math.min(day, lastOfMonth),
    seoul.getUTCHours(),
    seoul.getUTCMinutes(),
    seoul.getUTCSeconds(),
    seoul.getUTCMilliseconds()
  );
  return new Date(target - 9 * 3600 * 1000);
};

export type BiennialNoticeVerdict = {
  earliestDueAt: Date | null;
  recipients: number;
  problems: Array<{
    severity: "error" | "warning";
    code: "EMAIL_BIENNIAL_CONSENT_NOTICE_DUE" | "EMAIL_BIENNIAL_CONSENT_NOTICE_SOON";
    message: string;
  }>;
};

/**
 * Whether the deferral is still safe, and how close it is.
 *
 * Nobody anchored is not a problem: there is no Korean recipient to notify, and
 * reporting one would be reporting the absence of an obligation.
 */
export const biennialNoticeVerdict = (input: {
  anchors: readonly BiennialAnchor[];
  now: Date;
}): BiennialNoticeVerdict => {
  if (input.anchors.length === 0) {
    return { earliestDueAt: null, recipients: 0, problems: [] };
  }

  const due = input.anchors
    .map((anchor) => biennialNoticeDueAt(anchor.anchoredAt).getTime())
    .sort((a, b) => a - b);
  const earliest = due[0];
  const now = input.now.getTime();

  if (earliest <= now) {
    return {
      earliestDueAt: new Date(earliest),
      recipients: input.anchors.length,
      problems: [
        {
          severity: "error",
          code: "EMAIL_BIENNIAL_CONSENT_NOTICE_DUE",
          message:
            `The two-yearly consent notice fell due on ${onDay(new Date(earliest))} ` +
            `for at least one of ${input.anchors.length} Korean recipient(s), and it does not ` +
            "exist. Korean marketing is refused until it does (제50조제8항).",
        },
      ],
    };
  }

  if (earliest - now <= BIENNIAL_NOTICE_WARN_DAYS * DAY_MS) {
    return {
      earliestDueAt: new Date(earliest),
      recipients: input.anchors.length,
      problems: [
        {
          severity: "warning",
          code: "EMAIL_BIENNIAL_CONSENT_NOTICE_SOON",
          message:
            `The two-yearly consent notice falls due on ${onDay(new Date(earliest))} ` +
            `for the earliest of ${input.anchors.length} Korean recipient(s), inside the ` +
            `${BIENNIAL_NOTICE_WARN_DAYS}-day window. It has to exist before then.`,
        },
      ],
    };
  }

  return {
    earliestDueAt: new Date(earliest),
    recipients: input.anchors.length,
    problems: [],
  };
};
