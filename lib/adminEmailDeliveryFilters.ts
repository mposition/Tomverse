import type { EmailClassification } from "@/lib/emailTemplateDefinitions";

/**
 * What an operator may ask the delivery history, and what it will never answer.
 *
 * Contract: docs/policy/email-notifications.md §9.5, §13.7, §10.3.
 *
 * Pure, so the rules can be driven without a database. The queries live in
 * `lib/adminEmailDeliveries.ts`.
 *
 * ## The one thing this list must not become
 *
 * A way to read what was sent. `EmailDelivery` holds `renderDataSnapshot` --
 * the personalisation inputs, encrypted -- and on the credential lane it holds
 * nothing at all, because there the inputs *are* the credential (§9.4a-3). A
 * history screen that decrypted snapshots would be a screen where an
 * administrator reads other people's mail, and the reason the credential lane
 * stores no snapshot is that nobody should be able to. So the field list below
 * is an allowlist, `renderDataSnapshot` is not on it, and nothing here takes a
 * decryption key.
 *
 * `renderedSubject` is on it. A subject is written by us, is identical for
 * every recipient of a template version, and is what makes a row identifiable
 * as "the deletion notice" rather than a cuid.
 */

/** Statuses `EmailDelivery.status` can hold, in the order an operator scans. */
export const DELIVERY_STATUSES = [
  "abandoned",
  "failed",
  "bounced",
  "complained",
  "pending",
  "sent",
  "delivered",
  "suppressed",
  "skipped",
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_LANES = ["standard", "credential_sync"] as const;
export type DeliveryLane = (typeof DELIVERY_LANES)[number];

export const DELIVERY_CLASSIFICATIONS = [
  "transactional",
  "service",
  "legal",
  "marketing",
] as const;

/**
 * Statuses that mean nobody received the message and nobody will.
 *
 * The default view. A history screen opened to "everything" is a screen whose
 * first page is whatever happened to be sent in the last minute, and the
 * question an operator brings to it is almost always about a message that did
 * not arrive.
 */
export const UNDELIVERED_STATUSES: readonly DeliveryStatus[] = [
  "abandoned",
  "failed",
  "bounced",
  "complained",
];

export type DeliveryFilters = {
  statuses: DeliveryStatus[];
  classifications: EmailClassification[];
  lane: DeliveryLane | null;
  /** Normalised lowercase, exact match. Never a prefix or a LIKE. */
  emailAddress: string | null;
  templateKey: string | null;
  /** Rows created at or after this instant. */
  since: Date | null;
  limit: number;
  cursor: string | null;
};

export const DELIVERY_PAGE_SIZE = 50;
export const DELIVERY_PAGE_SIZE_MAX = 200;

const asArray = (value: string | string[] | undefined): string[] => {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean);
};

const pick = <T extends string>(
  values: string[],
  allowed: readonly T[]
): T[] => values.filter((value): value is T => (allowed as readonly string[]).includes(value));

/**
 * Reads one query string into filters, dropping anything it does not recognise.
 *
 * Deliberately forgiving rather than validating: this parses a URL a person may
 * have edited or a bookmark that outlived a status name, and answering a
 * hand-typed status with a 400 teaches nothing. What it never does is pass an
 * unrecognised value through to a query.
 */
export const parseDeliveryFilters = (
  query: Record<string, string | string[] | undefined>
): DeliveryFilters => {
  const statuses = pick(asArray(query.status), DELIVERY_STATUSES);
  const classifications = pick(
    asArray(query.classification),
    DELIVERY_CLASSIFICATIONS
  );
  const lane = pick(asArray(query.lane), DELIVERY_LANES)[0] ?? null;

  const rawAddress = (Array.isArray(query.address) ? query.address[0] : query.address)
    ?.trim()
    .toLowerCase();
  const rawTemplate = (Array.isArray(query.template) ? query.template[0] : query.template)?.trim();
  const rawSince = (Array.isArray(query.since) ? query.since[0] : query.since)?.trim();
  const rawLimit = (Array.isArray(query.limit) ? query.limit[0] : query.limit)?.trim();
  const rawCursor = (Array.isArray(query.cursor) ? query.cursor[0] : query.cursor)?.trim();

  const since = rawSince ? new Date(rawSince) : null;
  const limit = Number(rawLimit);

  return {
    statuses: statuses.length > 0 ? statuses : [...UNDELIVERED_STATUSES],
    classifications,
    lane,
    // An address filter is exact. A substring search over every address we have
    // ever mailed is a different feature with a different justification, and it
    // is the one that turns a support lookup into a way to enumerate users.
    emailAddress: rawAddress && rawAddress.includes("@") ? rawAddress : null,
    templateKey: rawTemplate && rawTemplate.length <= 120 ? rawTemplate : null,
    since: since && !Number.isNaN(since.getTime()) ? since : null,
    limit: Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), DELIVERY_PAGE_SIZE_MAX)
      : DELIVERY_PAGE_SIZE,
    cursor: rawCursor && rawCursor.length <= 60 ? rawCursor : null,
  };
};

/** Whether a filter set is the default one, for "you are seeing a subset" copy. */
export const isDefaultDeliveryFilter = (filters: DeliveryFilters) =>
  filters.classifications.length === 0 &&
  filters.lane === null &&
  filters.emailAddress === null &&
  filters.templateKey === null &&
  filters.since === null &&
  filters.statuses.length === UNDELIVERED_STATUSES.length &&
  UNDELIVERED_STATUSES.every((status) => filters.statuses.includes(status));

/**
 * Why a suppression may be lifted, and the shape the reason has to take.
 *
 * §13.7 requires a reason on removal and not on addition, which is not an
 * oversight: adding one stops mail, and removing one starts it again to an
 * address that a provider, or the person themselves, previously said to stop
 * mailing. The reason is the only record of why we overrode that.
 */
export const SUPPRESSION_REMOVAL_REASON_MIN = 10;
export const SUPPRESSION_REMOVAL_REASON_MAX = 500;

export type SuppressionRemovalProblem =
  | "reason_too_short"
  | "reason_too_long"
  | "reason_is_boilerplate";

/**
 * Rejects a reason that says nothing.
 *
 * A required field answered with "ok" is a required field that has been
 * defeated, and the entries this guards are the ones a regulator would ask
 * about. Matched on the whole answer after normalising case, punctuation and
 * spacing — a real reason that happens to contain the word "test" is fine, and
 * "Test." must not slip through where "test" does not.
 *
 * Checked before the length rule, deliberately. Most of these are under ten
 * characters, so a length-first order would answer every one of them with "too
 * short" and teach the writer to pad rather than to explain.
 */
/**
 * Non-answers, with every separator removed.
 *
 * Compared against the reason reduced to lowercase letters and digits, so
 * "N/A", "n.a." and "n a" are the same answer, and so is "Please remove!".
 * Punctuation variants are how a rejected non-answer usually comes back.
 */
const BOILERPLATE = new Set([
  "test",
  "testing",
  "testingthis",
  "na",
  "none",
  "noreason",
  "noreasongiven",
  "notneeded",
  "asdf",
  "asdfasdf",
  "remove",
  "removed",
  "removing",
  "removingthis",
  "pleaseremove",
  "cleanup",
  "cleanuptask",
  "fix",
  "fixed",
  "please",
  "ok",
  "okay",
  "asdiscussed",
  "customerasked",
  "userasked",
  "requested",
]);

const normaliseReason = (reason: string) =>
  reason.toLowerCase().replace(/[^a-z0-9]+/g, "");

export const suppressionRemovalProblem = (
  reason: string
): SuppressionRemovalProblem | null => {
  const trimmed = reason.trim();
  if (BOILERPLATE.has(normaliseReason(trimmed))) return "reason_is_boilerplate";
  if (trimmed.length < SUPPRESSION_REMOVAL_REASON_MIN) return "reason_too_short";
  if (trimmed.length > SUPPRESSION_REMOVAL_REASON_MAX) return "reason_too_long";
  return null;
};
