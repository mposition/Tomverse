/**
 * What the daily model lifecycle report says, as data rather than as text.
 *
 * The report has two renderings -- HTML and plain text -- and one of the ways a
 * report rots is that they drift: somebody adds a section to the HTML and the
 * text half keeps describing yesterday's shape. Both renderers read the
 * structure this module returns, so a section that exists in one exists in the
 * other or in neither.
 *
 * Pure on purpose. No Prisma, no `new Date()`, no timezone lookup: the caller
 * resolves those and passes the results in. That is not only for testing -- the
 * standard email lane stores the payload a message was rendered from and
 * re-renders it on every retry, so a report that read the clock would say
 * something different on its second attempt than on its first, and the
 * provider's idempotency key would stop suppressing the duplicate.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md section 10.
 */

/** Statuses that mean "a person has not answered yet". */
const UNDECIDED_STATUSES = new Set(["discovered", "awaiting_decision", "deferred"]);

/** Statuses that mean "decided, and not yet finished". */
const IN_FLIGHT_STATUSES = new Set([
  "approved",
  "implementation_pending",
  "validation_pending",
  "rollout_pending",
  "communication_pending",
]);

/**
 * Rows per section before the report stops listing and starts counting.
 *
 * 25 rather than the 20/100 the first version used, and the cap now carries the
 * total and a link with it (ML-04). A truncated list that does not say what it
 * truncated is worse than a long one: the reader cannot tell whether the two
 * rows they see are the whole story.
 */
export const REPORT_SECTION_LIMIT = 25;

/**
 * Above this many undecided items the report stops listing them individually.
 *
 * A 200-line email is not read, and the failure this whole change exists to fix
 * was a report nobody acted on. Past this point the honest thing is a per
 * provider count and a link.
 */
export const AWAITING_DIGEST_THRESHOLD = 50;

export type LifecycleReportWorkItem = {
  id: string;
  /**
   * The catalogue the scan that filed this item was reading.
   *
   * Kept because it is a fact about the item, but it is not the answer to "who
   * made this model" and no renderer may present it as one (ML-13). That is
   * what `owner` is for.
   */
  provider: string;
  /**
   * Display name of the organisation that publishes the model, or "unknown".
   *
   * Named `publisher` rather than `owner` because `ownerEmail` on this same
   * type means the person the item is assigned to. Two different owners on one
   * row is how a renderer picks the wrong one.
   */
  publisher: string;
  /** Every catalogue the model has been seen in, newest sighting appended. */
  observedVia: Array<{ provider: string; displayName: string; apiModel: string }>;
  apiModel: string;
  action: string;
  status: string;
  severity: string;
  ownerEmail: string | null;
  /** ISO 8601, or null when nobody has set a date. */
  dueAt: string | null;
  /** ISO 8601. */
  firstSeenAt: string;
  /** Whole days between discovery and this run, resolved by the caller. */
  ageDays: number;
  /** True when this run is the one that created the item. */
  newToday: boolean;
  blockers: string[];
  pendingValidations: string[];
  recommendation: string | null;
};

export type LifecycleReportProvider = {
  provider: string;
  displayName: string;
  status: "checked" | "failed" | "skipped";
  errorCode: string | null;
  /** Models the provider listed on this run. Null when the run did not complete. */
  modelCount: number | null;
  /** Pre-formatted by the caller, in the report's timezone. */
  lastSuccessLabel: string | null;
  note: string | null;
};

export type LifecycleReportRegistryChange = {
  provider: string;
  displayName: string;
  apiModel: string;
  detail: string;
};

export type LifecycleReportChanges = {
  discovered: number;
  decided: number;
  transitions: number;
  completed: number;
};

export type LifecycleReportInput = {
  /** Date in the report's timezone, e.g. "22 Aug 2026". */
  localDate: string;
  /** Date and time with zone, e.g. "22 Aug 2026, 10:00 am AEST". */
  generatedLabel: string;
  workQueueUrl: string;
  providers: LifecycleReportProvider[];
  workItems: LifecycleReportWorkItem[];
  lifecycleWarnings: Array<{ displayName: string; apiModel: string; lifecycle: string }>;
  missing: Array<{ displayName: string; apiModel: string; consecutiveMissing: number }>;
  registry: {
    ran: boolean;
    disabled: LifecycleReportRegistryChange[];
    restored: LifecycleReportRegistryChange[];
    held: LifecycleReportRegistryChange[];
  };
  /** Absent when the history could not be read; the section is then omitted. */
  changes?: LifecycleReportChanges;
  test?: boolean;
};

export type ReportList<Row> = {
  rows: Row[];
  /** How many there are in total, which may be more than `rows.length`. */
  total: number;
  /** `total - rows.length`, precomputed so no renderer has to subtract. */
  hidden: number;
};

export type LifecycleReportSummary = {
  providersChecked: number;
  providersTotal: number;
  providersFailed: number;
  newToday: number;
  awaitingReview: number;
  approvedNotShipped: number;
  lifecycleWarnings: number;
  autoDisabled: number;
  restored: number;
  held: number;
};

export type DailyLifecycleReport = {
  subject: string;
  localDate: string;
  generatedLabel: string;
  workQueueUrl: string;
  /** True when nothing is waiting and no provider failed. */
  allClear: boolean;
  actionCount: number;
  summary: LifecycleReportSummary;
  actionRequired: ReportList<LifecycleReportWorkItem>;
  newToday: ReportList<LifecycleReportWorkItem>;
  pending: ReportList<LifecycleReportWorkItem>;
  /**
   * Set instead of `pending` rows once the queue is past
   * AWAITING_DIGEST_THRESHOLD: provider, count, and nothing else.
   */
  pendingDigest: Array<{ displayName: string; count: number }> | null;
  inFlight: ReportList<LifecycleReportWorkItem>;
  lifecycleWarnings: ReportList<{ displayName: string; apiModel: string; lifecycle: string }>;
  missing: ReportList<{ displayName: string; apiModel: string; consecutiveMissing: number }>;
  registryChanges: ReportList<LifecycleReportRegistryChange & { kind: string }>;
  registryRan: boolean;
  changes: LifecycleReportChanges | null;
  providers: LifecycleReportProvider[];
};

const list = <Row>(rows: Row[], limit = REPORT_SECTION_LIMIT): ReportList<Row> => {
  const visible = rows.slice(0, limit);
  return { rows: visible, total: rows.length, hidden: rows.length - visible.length };
};

/**
 * Severity decides what is shouted about, and it is the item's own severity
 * rather than anything derived here.
 *
 * `normal` items are still listed -- under "awaiting decision", where they
 * belong. The distinction the banner is making is "somebody has to do something
 * about this today", and a normal-severity addition discovered this morning
 * does not qualify no matter how many of them there are.
 */
const isActionable = (item: LifecycleReportWorkItem) =>
  item.severity === "critical" || item.severity === "high";

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, normal: 2 };

const bySeverityThenAge = (a: LifecycleReportWorkItem, b: LifecycleReportWorkItem) => {
  const severity = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
  if (severity !== 0) return severity;
  return b.ageDays - a.ageDays;
};

/**
 * The subject line, which is the only part of this report most days.
 *
 * A number in the subject means there is something to do. That is why a healthy
 * day says "healthy" rather than "0 awaiting review": a subject that always
 * carries a count trains the reader to stop reading counts.
 */
export const dailyReportSubject = (input: {
  localDate: string;
  actionCount: number;
  providersFailed: number;
  awaitingReview: number;
  test?: boolean;
}) => {
  const segments: string[] = [];
  if (input.actionCount > 0) segments.push(`ACTION ${input.actionCount}`);
  if (input.providersFailed > 0) {
    segments.push(
      `${input.providersFailed} provider${input.providersFailed === 1 ? "" : "s"} failed`
    );
  }
  if (input.awaitingReview > 0) segments.push(`${input.awaitingReview} awaiting review`);
  if (!segments.length) segments.push("healthy");
  return `${input.test ? "[TEST] " : ""}[Tomverse] Model lifecycle · ${input.localDate} · ${segments.join(" · ")}`;
};

export const buildDailyLifecycleReport = (
  input: LifecycleReportInput
): DailyLifecycleReport => {
  const undecided = input.workItems.filter((item) => UNDECIDED_STATUSES.has(item.status));
  const inFlight = input.workItems.filter((item) => IN_FLIGHT_STATUSES.has(item.status));
  const actionRequired = input.workItems.filter(isActionable).sort(bySeverityThenAge);
  const newToday = undecided.filter((item) => item.newToday);
  const pending = undecided
    .filter((item) => !item.newToday)
    .sort((a, b) => b.ageDays - a.ageDays);

  const providersFailed = input.providers.filter(
    (provider) => provider.status !== "checked"
  ).length;

  const registryChanges = [
    ...input.registry.disabled.map((row) => ({ ...row, kind: "disabled" })),
    ...input.registry.restored.map((row) => ({ ...row, kind: "restored" })),
    ...input.registry.held.map((row) => ({ ...row, kind: "held" })),
  ];

  const summary: LifecycleReportSummary = {
    providersChecked: input.providers.length - providersFailed,
    providersTotal: input.providers.length,
    providersFailed,
    newToday: newToday.length,
    awaitingReview: undecided.length,
    approvedNotShipped: inFlight.length,
    lifecycleWarnings: input.lifecycleWarnings.length,
    autoDisabled: input.registry.disabled.length,
    restored: input.registry.restored.length,
    held: input.registry.held.length,
  };

  // Past the threshold the individual rows go and a per-provider count stays.
  // Counted from every undecided item rather than from the un-truncated
  // remainder, because "43 pending" is the number the reader needs whether or
  // not three of them were discovered this morning.
  const digest =
    undecided.length > AWAITING_DIGEST_THRESHOLD
      ? Object.entries(
          undecided.reduce<Record<string, { displayName: string; count: number }>>(
            (accumulator, item) => {
              const key = item.provider;
              accumulator[key] = {
                displayName: accumulator[key]?.displayName ?? item.provider,
                count: (accumulator[key]?.count ?? 0) + 1,
              };
              return accumulator;
            },
            {}
          )
        )
          .map(([, value]) => value)
          .sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName))
      : null;

  const allClear =
    undecided.length === 0 &&
    inFlight.length === 0 &&
    providersFailed === 0 &&
    input.lifecycleWarnings.length === 0;

  return {
    subject: dailyReportSubject({
      localDate: input.localDate,
      actionCount: actionRequired.length,
      providersFailed,
      awaitingReview: undecided.length,
      test: input.test,
    }),
    localDate: input.localDate,
    generatedLabel: input.generatedLabel,
    workQueueUrl: input.workQueueUrl,
    allClear,
    actionCount: actionRequired.length,
    summary,
    actionRequired: list(actionRequired),
    newToday: list(digest ? [] : newToday),
    pending: list(digest ? [] : pending),
    pendingDigest: digest,
    inFlight: list(inFlight),
    lifecycleWarnings: list(input.lifecycleWarnings),
    missing: list(input.missing),
    registryChanges: list(registryChanges),
    registryRan: input.registry.ran,
    changes: input.changes ?? null,
    providers: input.providers,
  };
};
