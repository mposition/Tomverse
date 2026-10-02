/**
 * Drafting a staging webhook verification record from what staging stored
 * (S2 plan, S2e-verification: "Generate the strict record field-by-field").
 *
 * Pure. The caller reads the shadow reports, the fault arm and the staging
 * configuration snapshot; this decides which conditions the stored rows prove
 * and refuses to write a record whose conditions they do not. c1 and c2 are
 * delivery facts (a signed delivery accepted, an unsigned one refused) that
 * live in request logs, not in the database, so they arrive as evidence
 * references the executor observed -- never as a default.
 */
import {
  MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  canonicalMarketingWebhookFileText,
  digestMarketingWebhookVerificationRecord,
  marketingWebhookVerificationRecordSchema,
} from "@/lib/marketingAutomationAccess";

export type MarketingWebhookShadowRow = {
  readonly eventIdDigest: string;
  readonly eventType: string;
  readonly channelId: string;
  readonly statusQueryMatch: boolean;
};

export type MarketingWebhookConsumedArm = {
  readonly eventIdDigest: string;
  readonly state: "armed" | "consumed";
};

export type MarketingWebhookRecordDraftInput = {
  readonly recordId: string;
  readonly executor: string;
  readonly stagingCommitSha: string;
  readonly stagingConfigSnapshotDigest: string;
  readonly reports: readonly MarketingWebhookShadowRow[];
  readonly faultArm: MarketingWebhookConsumedArm | null;
  /** What the executor observed for c1 and c2, as references; required, never inferred. */
  readonly c1EvidenceRefs: readonly string[];
  readonly c2EvidenceRefs: readonly string[];
  /** Any further references (log exports, screenshots) to carry. */
  readonly evidenceRefs: readonly string[];
};

export type MarketingWebhookRecordDraftProblem =
  | "c1_evidence_missing"
  | "c2_evidence_missing"
  | "c3_no_reports"
  | "c3_duplicate_event"
  | "c4_fault_not_consumed"
  | "c4_fault_event_not_recorded_once"
  | "c5_no_matching_pair";

export type MarketingWebhookRecordDraft =
  | {
      readonly ok: true;
      readonly fileText: string;
      readonly recordDigest: string;
      /** Pairs left out because a status query did not agree for every event of the pair. */
      readonly excludedPairs: ReadonlyArray<{ eventType: string; channelId: string }>;
    }
  | { readonly ok: false; readonly problems: readonly MarketingWebhookRecordDraftProblem[] };

const pairKey = (row: { eventType: string; channelId: string }) =>
  JSON.stringify([row.eventType, row.channelId]);

export const draftMarketingWebhookVerificationRecord = (
  input: MarketingWebhookRecordDraftInput,
): MarketingWebhookRecordDraft => {
  const problems: MarketingWebhookRecordDraftProblem[] = [];
  if (input.c1EvidenceRefs.length === 0) problems.push("c1_evidence_missing");
  if (input.c2EvidenceRefs.length === 0) problems.push("c2_evidence_missing");

  // c3: each event stored exactly once.
  const perDigest = new Map<string, number>();
  for (const row of input.reports) {
    perDigest.set(row.eventIdDigest, (perDigest.get(row.eventIdDigest) ?? 0) + 1);
  }
  if (input.reports.length === 0) problems.push("c3_no_reports");
  if ([...perDigest.values()].some((count) => count !== 1)) problems.push("c3_duplicate_event");

  // c4: one deliberate failure was spent, and its event was then stored once --
  // the retry after the 5xx landed, and was not stored twice.
  if (input.faultArm?.state !== "consumed") {
    problems.push("c4_fault_not_consumed");
  } else if (perDigest.get(input.faultArm.eventIdDigest) !== 1) {
    problems.push("c4_fault_event_not_recorded_once");
  }

  // c5: a pair is observed only when every stored event of it agreed with
  // the status query. One disagreement leaves the pair out of the scope.
  const agreed = new Map<string, { eventType: string; channelId: string }>();
  const disagreed = new Map<string, { eventType: string; channelId: string }>();
  for (const row of input.reports) {
    const pair = { eventType: row.eventType, channelId: row.channelId };
    (row.statusQueryMatch ? agreed : disagreed).set(pairKey(pair), pair);
  }
  for (const key of disagreed.keys()) agreed.delete(key);
  if (agreed.size === 0) problems.push("c5_no_matching_pair");

  if (problems.length > 0) return { ok: false, problems };

  const observedScope = [...agreed.values()].sort((left, right) =>
    pairKey(left) < pairKey(right) ? -1 : pairKey(left) > pairKey(right) ? 1 : 0,
  );
  const record = {
    recordId: input.recordId,
    executor: input.executor,
    stagingCommitSha: input.stagingCommitSha,
    observedScope,
    conditions: { c1: "pass", c2: "pass", c3: "pass", c4: "pass", c5: "pass" },
    evidenceRefs: [...new Set([...input.c1EvidenceRefs, ...input.c2EvidenceRefs, ...input.evidenceRefs])],
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
    excludedPairs: [...disagreed.values()],
  };
};
