/**
 * Signing a staging webhook verification record (S2 plan, S2e-verification).
 *
 * The record is an immutable repository file under
 * `docs/ops/marketing-webhook-verification-records/`. An operator signs the
 * exact digest of its bytes; the route writes the S1 exact audit action
 * `marketing_webhook.verification_signed` and returns the sibling signature
 * file's content, which the operator commits next to the record.
 *
 * Kept apart from the store so the route's refusal class does not pull the
 * store into anything that only needs to recognise it. Everything here is pure
 * except `readMarketingWebhookVerificationRecordFile`, which reads the file the
 * deployed tree carries.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  MARKETING_WEBHOOK_PIPELINE_FINGERPRINT,
  canonicalMarketingWebhookFileText,
  digestMarketingWebhookVerificationRecord,
  marketingWebhookVerificationRecordSchema,
} from "@/lib/marketingAutomationAccess";

export const MARKETING_WEBHOOK_VERIFICATION_RECORD_DIR =
  "docs/ops/marketing-webhook-verification-records";

/** Same shape the record schema gives `recordId`; also what keeps the path inside the directory. */
export const MARKETING_WEBHOOK_RECORD_ID_PATTERN = /^\d{4}-\d{2}-\d{2}__[a-z0-9-]{1,64}$/;

export class MarketingWebhookVerificationRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MarketingWebhookVerificationRefusedError";
    this.code = code;
  }
}

/** The repository path of a record, or a refusal for an id that is not one. */
export const marketingWebhookVerificationRecordPath = (recordId: string): string => {
  if (!MARKETING_WEBHOOK_RECORD_ID_PATTERN.test(recordId)) {
    throw new MarketingWebhookVerificationRefusedError(
      "record_id_invalid",
      "The record id is not a verification record id.",
    );
  }
  return `${MARKETING_WEBHOOK_VERIFICATION_RECORD_DIR}/${recordId}.json`;
};

/**
 * The record file as the deployed tree carries it, or `null` when it is not
 * there. The app runs from the repository root (`next start`), so the path is
 * relative to the working directory.
 */
export const readMarketingWebhookVerificationRecordFile = async (
  recordId: string,
): Promise<string | null> => {
  const relative = marketingWebhookVerificationRecordPath(recordId);
  try {
    return await readFile(path.join(process.cwd(), relative), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw error;
  }
};

export type MarketingWebhookVerificationSignature = {
  readonly recordId: string;
  readonly recordDigest: string;
  readonly signatureAuditLogId: string;
};

/**
 * Whether this file is the record the operator means to sign, judged before
 * anything is written.
 *
 * The digest the operator sends must equal the digest of the bytes the deployed
 * tree carries: a signature binds what was read, not what was meant. A record
 * whose pipeline fingerprint is not this build's is refused too -- the apply
 * decision would call it stale at once, so signing it records nothing usable.
 */
export const checkMarketingWebhookRecordForSigning = (input: {
  readonly recordId: string;
  readonly recordDigest: string;
  readonly fileText: string | null;
}): void => {
  if (input.fileText === null) {
    throw new MarketingWebhookVerificationRefusedError(
      "record_not_found",
      "No verification record with this id is in the deployed tree.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalMarketingWebhookFileText(input.fileText));
  } catch {
    throw new MarketingWebhookVerificationRefusedError(
      "record_invalid",
      "The verification record is not JSON.",
    );
  }
  const record = marketingWebhookVerificationRecordSchema.safeParse(parsed);
  if (!record.success) {
    throw new MarketingWebhookVerificationRefusedError(
      "record_invalid",
      "The verification record does not match the strict record schema.",
    );
  }
  if (record.data.recordId !== input.recordId) {
    throw new MarketingWebhookVerificationRefusedError(
      "record_id_mismatch",
      "The record names a different id than its file.",
    );
  }
  if (digestMarketingWebhookVerificationRecord(input.fileText) !== input.recordDigest) {
    throw new MarketingWebhookVerificationRefusedError(
      "record_digest_mismatch",
      "The digest does not match the record the deployed tree carries.",
    );
  }
  if (record.data.pipelineFingerprint !== MARKETING_WEBHOOK_PIPELINE_FINGERPRINT) {
    throw new MarketingWebhookVerificationRefusedError(
      "record_pipeline_stale",
      "The record was made against a different webhook pipeline than this build.",
    );
  }
};
