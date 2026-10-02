/**
 * Drafting a staging webhook verification record from what staging stored and
 * what Zernio delivered (S2 plan, S2e-verification; docs/policy/marketing-automation.md §8.1.1).
 *
 * Pure. The caller reads the shadow reports from the database and the delivery
 * attempts from Zernio's webhook log; this decides, **per event type**, which of
 * conditions 1-5 those facts prove, and puts in the scope only the
 * `event type x channel` pairs whose type proved all of them. Order is
 * evidence: condition 3 needs a redelivery *after* the event was recorded, and
 * condition 4 needs the deliberate failure to come *before* the event was ever
 * processed -- final rows alone cannot tell either from a first delivery.
 *
 * Condition 2 (unsigned or tampered requests refused before parsing) is not
 * about an event type. Zernio only ever sends signed requests, so it is proved
 * by probes the drafting script sends itself: no signature and a wrong one,
 * each on a body that is not JSON -- a receiver that parsed before verifying
 * would answer 400, not 401 -- a wrong signature on a well-formed event, and a
 * correctly signed event with one byte changed and with one byte appended after
 * signing (a receiver that trimmed or normalised before verifying would accept
 * the second). Each must be answered 401 by this build with the stored reports
 * unchanged. A control comes first: the same signing, untampered, must be
 * accepted (200, an account that is not ours, nothing stored) -- otherwise the
 * script's secret is not the receiver's, and every signed probe was refused for
 * that reason rather than for the change.
 */
import {
  MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  canonicalMarketingWebhookFileText,
  digestMarketingWebhookVerificationRecord,
  marketingWebhookVerificationRecordSchema,
} from "@/lib/marketingAutomationAccess";
import {
  MARKETING_WEBHOOK_PROVIDER,
  marketingWebhookEventIdDigest,
} from "@/lib/marketingWebhookCore";

export type MarketingWebhookShadowRow = {
  readonly eventIdDigest: string;
  readonly eventType: string;
  readonly channelId: string;
  readonly statusQueryMatch: boolean;
};

/** One attempt from Zernio's webhook log, reduced to what the receiver answered. */
export type MarketingWebhookDelivery = {
  readonly eventId: string;
  readonly event: string;
  /** When Zernio made the attempt, as its log states it. */
  readonly at: string;
  readonly statusCode: number;
  /** The receiver's `status` or `code` from the response body, or null if it had none. */
  readonly answer: string | null;
  /** The build that answered, as the response body names it; null when it names none. */
  readonly pipeline: string | null;
  /** The configuration a signed answer ran under; null when unsigned or unreadable. */
  readonly config: string | null;
};

export type MarketingWebhookRecordDraftInput = {
  readonly recordId: string;
  readonly executor: string;
  readonly stagingCommitSha: string;
  readonly stagingConfigSnapshotDigest: string;
  readonly reports: readonly MarketingWebhookShadowRow[];
  readonly deliveries: readonly MarketingWebhookDelivery[];
  /** The script's own refused requests for condition 2. */
  readonly c2Probes: readonly MarketingWebhookC2Probe[];
  readonly evidenceRefs: readonly string[];
};

export const MARKETING_WEBHOOK_C2_PROBE_KINDS = [
  "signed_control",
  "unsigned_not_json",
  "wrong_signature_not_json",
  "wrong_signature_event",
  "signed_byte_changed",
  "signed_byte_appended",
] as const;

export type MarketingWebhookC2Probe = {
  readonly kind: (typeof MARKETING_WEBHOOK_C2_PROBE_KINDS)[number];
  readonly at: string;
  readonly statusCode: number;
  readonly answer: string | null;
  readonly pipeline: string | null;
  /** Shadow reports counted just before and just after the probe. */
  readonly reportsBefore: number;
  readonly reportsAfter: number;
};

export type MarketingWebhookTypeShortfall = "c1" | "c3" | "c4" | "c5";

export type MarketingWebhookRecordDraftProblem =
  | "c2_probe_missing"
  | "c2_control_not_accepted"
  | "c2_probe_not_refused"
  | "c2_probe_stored"
  | "no_event_type_proved";

export type MarketingWebhookRecordDraft =
  | {
      readonly ok: true;
      readonly fileText: string;
      readonly recordDigest: string;
      /** Event types seen but left out, with the conditions each did not prove. */
      readonly excludedTypes: ReadonlyArray<{ eventType: string; missing: MarketingWebhookTypeShortfall[] }>;
      /** Pairs of a proved type left out because a status query disagreed. */
      readonly excludedPairs: ReadonlyArray<{ eventType: string; channelId: string }>;
    }
  | {
      readonly ok: false;
      readonly problems: readonly MarketingWebhookRecordDraftProblem[];
      readonly excludedTypes: ReadonlyArray<{ eventType: string; missing: MarketingWebhookTypeShortfall[] }>;
    };

const PROCESSED = new Set(["recorded", "duplicate"]);

const time = (value: string): number => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Unreadable delivery time: ${value}`);
  return parsed;
};

const deliveryRef = (delivery: MarketingWebhookDelivery) =>
  `zernio-webhook-log:${delivery.eventId}:${delivery.at}:${delivery.statusCode}:${delivery.answer ?? "-"}`;

const comparePairs = (
  left: { eventType: string; channelId: string },
  right: { eventType: string; channelId: string },
) => {
  const a = JSON.stringify([left.eventType, left.channelId]);
  const b = JSON.stringify([right.eventType, right.channelId]);
  return a < b ? -1 : a > b ? 1 : 0;
};

export const draftMarketingWebhookVerificationRecord = (
  input: MarketingWebhookRecordDraftInput,
): MarketingWebhookRecordDraft => {
  const refs = new Set<string>();
  // Positive evidence is only what this build answered under this configuration
  // (docs/policy/marketing-automation.md §8.1.1: a change re-opens
  // verification). Earlier observations stay in the order checks -- an event
  // recorded by an older build is still not unprocessed.
  const current = (attempt: MarketingWebhookDelivery) =>
    attempt.pipeline === MARKETING_WEBHOOK_PIPELINE_FINGERPRINT &&
    attempt.config === input.stagingConfigSnapshotDigest;
  const recordedNow = new Set(
    input.deliveries
      .filter((attempt) => current(attempt) && attempt.statusCode === 200 && attempt.answer === "recorded")
      .map((attempt) => marketingWebhookEventIdDigest(MARKETING_WEBHOOK_PROVIDER, attempt.eventId)),
  );
  // Rows count only for events this build recorded under this configuration.
  const reports = input.reports.filter((row) => recordedNow.has(row.eventIdDigest));

  const reportsByDigest = new Map<string, MarketingWebhookShadowRow[]>();
  for (const row of input.reports) {
    // Every stored row, so a second row of the event is seen whatever stored it.
    reportsByDigest.set(row.eventIdDigest, [...(reportsByDigest.get(row.eventIdDigest) ?? []), row]);
  }
  /** Exactly one stored report of this event, and of this type. */
  const storedOnce = (eventId: string, eventType: string) => {
    const rows = reportsByDigest.get(marketingWebhookEventIdDigest(MARKETING_WEBHOOK_PROVIDER, eventId)) ?? [];
    return rows.length === 1 && rows[0]?.eventType === eventType;
  };

  const attemptsByEvent = new Map<string, MarketingWebhookDelivery[]>();
  for (const delivery of input.deliveries) {
    attemptsByEvent.set(delivery.eventId, [...(attemptsByEvent.get(delivery.eventId) ?? []), delivery]);
  }
  for (const attempts of attemptsByEvent.values()) attempts.sort((a, b) => time(a.at) - time(b.at));

  const proveType = (eventType: string): MarketingWebhookTypeShortfall[] => {
    const events = [...attemptsByEvent.entries()].filter(([, attempts]) =>
      attempts.every((attempt) => attempt.event === eventType),
    );
    const used: MarketingWebhookDelivery[] = [];

    // 1: a signed delivery of this type was accepted and stored.
    const c1 = events.find(
      ([eventId, attempts]) =>
        storedOnce(eventId, eventType) &&
        attempts.some((attempt) => current(attempt) && attempt.statusCode === 200 && attempt.answer === "recorded"),
    );
    if (c1) used.push(...c1[1].filter((attempt) => attempt.answer === "recorded"));

    // 3: after it was recorded, a later delivery of the same event changed nothing.
    const c3 = events.find(([eventId, attempts]) => {
      if (!storedOnce(eventId, eventType)) return false;
      const recorded = attempts.find((attempt) => current(attempt) && attempt.answer === "recorded");
      return (
        recorded !== undefined &&
        attempts.some(
          (attempt) =>
            current(attempt) &&
            attempt.answer === "duplicate" &&
            attempt.statusCode === 200 &&
            time(attempt.at) > time(recorded.at),
        )
      );
    });
    if (c3) used.push(...c3[1].filter((attempt) => PROCESSED.has(attempt.answer ?? "")));

    // 4: the deliberate failure came before the event was ever processed, and a
    // later delivery then processed it exactly once.
    const c4 = events.find(([eventId, attempts]) => {
      if (!storedOnce(eventId, eventType)) return false;
      const failure = attempts.findIndex(
        (attempt) => current(attempt) && attempt.statusCode === 503 && attempt.answer === "deliberate_fault",
      );
      if (failure < 0) return false;
      const before = attempts.slice(0, failure);
      const after = attempts.slice(failure + 1);
      return (
        !before.some((attempt) => PROCESSED.has(attempt.answer ?? "")) &&
        after.filter((attempt) => attempt.answer === "recorded").length === 1 &&
        after.some(
          (attempt) =>
            current(attempt) && attempt.answer === "recorded" && time(attempt.at) > time(attempts[failure]!.at),
        )
      );
    });
    if (c4) used.push(...c4[1]);

    // 5: at least one pair of this type agreed with the status query throughout.
    const pairs = new Map<string, boolean>();
    for (const row of reports.filter((report) => report.eventType === eventType)) {
      const key = row.channelId;
      pairs.set(key, (pairs.get(key) ?? true) && row.statusQueryMatch);
    }
    const c5 = [...pairs.values()].some(Boolean);

    const missing: MarketingWebhookTypeShortfall[] = [];
    if (!c1) missing.push("c1");
    if (!c3) missing.push("c3");
    if (!c4) missing.push("c4");
    if (!c5) missing.push("c5");
    if (missing.length === 0) for (const attempt of used) refs.add(deliveryRef(attempt));
    return missing;
  };

  const problems: MarketingWebhookRecordDraftProblem[] = [];
  for (const kind of MARKETING_WEBHOOK_C2_PROBE_KINDS) {
    const probes = input.c2Probes.filter((probe) => probe.kind === kind);
    if (probes.length === 0) {
      problems.push("c2_probe_missing");
    } else if (kind === "signed_control") {
      // Accepted by this build, about an account that is not ours (or with the
      // shadow off), and nothing stored.
      if (
        !probes.every(
          (probe) =>
            probe.statusCode === 200 &&
            (probe.answer === "channel_unknown" || probe.answer === "shadow_off") &&
            probe.pipeline === MARKETING_WEBHOOK_PIPELINE_FINGERPRINT &&
            probe.reportsAfter === probe.reportsBefore,
        )
      ) {
        problems.push("c2_control_not_accepted");
      }
    } else if (
      !probes.every(
        (probe) =>
          probe.statusCode === 401 &&
          probe.answer === "signature_invalid" &&
          probe.pipeline === MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
      )
    ) {
      problems.push("c2_probe_not_refused");
    } else if (!probes.every((probe) => probe.reportsAfter === probe.reportsBefore)) {
      problems.push("c2_probe_stored");
    }
  }

  const types = [...new Set(input.deliveries.map((delivery) => delivery.event))].sort();
  const excludedTypes: Array<{ eventType: string; missing: MarketingWebhookTypeShortfall[] }> = [];
  const observedScope: Array<{ eventType: string; channelId: string }> = [];
  const excludedPairs: Array<{ eventType: string; channelId: string }> = [];
  for (const eventType of types) {
    // Deliveries Zernio sends that the receiver never records (its test event)
    // have no stored rows and cannot be in scope; they are not reported as shortfalls.
    if (!reports.some((report) => report.eventType === eventType)) continue;
    const missing = proveType(eventType);
    if (missing.length > 0) {
      excludedTypes.push({ eventType, missing });
      continue;
    }
    const channels = new Map<string, boolean>();
    for (const row of reports.filter((report) => report.eventType === eventType)) {
      channels.set(row.channelId, (channels.get(row.channelId) ?? true) && row.statusQueryMatch);
    }
    for (const [channelId, agreed] of channels) {
      (agreed ? observedScope : excludedPairs).push({ eventType, channelId });
    }
  }
  if (observedScope.length === 0) problems.push("no_event_type_proved");
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)], excludedTypes };

  for (const probe of input.c2Probes) {
    refs.add(`probe:${probe.kind}:${probe.at}:${probe.statusCode}:${probe.answer ?? "-"}`);
  }
  const record = {
    recordId: input.recordId,
    executor: input.executor,
    stagingCommitSha: input.stagingCommitSha,
    observedScope: observedScope.sort(comparePairs),
    conditions: { c1: "pass", c2: "pass", c3: "pass", c4: "pass", c5: "pass" },
    evidenceRefs: [...new Set([...input.evidenceRefs, ...[...refs].sort()])],
    pipelineFingerprint: MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
    stagingConfigSnapshotDigest: input.stagingConfigSnapshotDigest,
  };
  // The same strict schema the signing route and the apply decision read with.
  marketingWebhookVerificationRecordSchema.parse(record);
  const fileText = canonicalMarketingWebhookFileText(`${JSON.stringify(record, null, 2)}\n`);
  return {
    ok: true,
    fileText,
    recordDigest: digestMarketingWebhookVerificationRecord(fileText),
    excludedTypes,
    excludedPairs: excludedPairs.sort(comparePairs),
  };
};
