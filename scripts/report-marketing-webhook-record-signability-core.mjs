/**
 * Which staging webhook verification records this build could sign (S2 plan,
 * S2e-verification).
 *
 * The question this answers is one an operator otherwise answers by walking to
 * the production console and being refused: a record is signable only while its
 * pipeline fingerprint is still this build's, and that fingerprint moves with
 * almost every selective release to main, because the receiver's import closure
 * includes the whole watched Prisma schema and the system-actor list that other
 * teams' releases touch. On 2026-10-10 the record deployed as #2220 was already
 * stale, as were the two before it.
 *
 * **This module owns no rule.** The verdict of each record is decided by
 * `checkMarketingWebhookRecordForSigning()` in `lib/marketingWebhookVerification.ts`
 * -- the same function the signing route calls -- and reaches here only as its
 * refusal code. Everything below is the summary: grouping, counting and naming.
 * A second copy of the staleness comparison would be a report that can disagree
 * with the console it is meant to predict.
 */

/** A record this build would accept for signing. */
export const RECORD_SIGNABLE = "signable";
/** Refused because the record was made against a different webhook pipeline. */
export const RECORD_STALE = "stale";
/** Refused for any other reason the signing route gives. */
export const RECORD_REFUSED = "refused";

/** The refusal code the signing route uses for a record from another build. */
export const PIPELINE_STALE_REFUSAL_CODE = "record_pipeline_stale";

const verdictOf = (refusalCode) => {
  if (refusalCode === null) return RECORD_SIGNABLE;
  if (refusalCode === PIPELINE_STALE_REFUSAL_CODE) return RECORD_STALE;
  return RECORD_REFUSED;
};

/**
 * Groups already-judged records.
 *
 * `records` carries, per record, the refusal code the signing route produced
 * (`null` when it accepted) and the fingerprint the record declares. The
 * declared fingerprint is reported so a reader can see *which* build a stale
 * record belongs to; it is never what decides the verdict.
 *
 * `refusalCode` must be stated. An absent key is a caller that has not said
 * what the route answered, and reading that as "accepted" is the one mistake
 * this report cannot afford: it would print `signable` for a record nobody
 * judged. The declared fingerprint stays optional, because it only decides what
 * a line says, not what the verdict is.
 */
export const summariseMarketingWebhookRecordSignability = ({
  buildFingerprint,
  records,
}) => {
  const judged = records.map((record) => {
    if (!("refusalCode" in record)) {
      throw new TypeError(
        `Record ${record.recordId} does not state a refusalCode; the signing route's answer is what decides the verdict.`,
      );
    }
    return {
      recordId: record.recordId,
      declaredFingerprint: record.declaredFingerprint ?? null,
      refusalCode: record.refusalCode ?? null,
      refusalMessage: record.refusalMessage ?? null,
      verdict: verdictOf(record.refusalCode ?? null),
    };
  });
  const idsWith = (verdict) =>
    judged.filter((record) => record.verdict === verdict).map((record) => record.recordId);
  const signableRecordIds = idsWith(RECORD_SIGNABLE);
  return {
    buildFingerprint,
    records: judged,
    signableRecordIds,
    staleRecordIds: idsWith(RECORD_STALE),
    refusedRecordIds: idsWith(RECORD_REFUSED),
    verdict:
      judged.length === 0
        ? "no_records"
        : signableRecordIds.length > 0
          ? "signable"
          : "none_signable",
  };
};
