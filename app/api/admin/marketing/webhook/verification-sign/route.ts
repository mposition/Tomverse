export const dynamic = "force-dynamic";

import { z } from "zod";

import {
  MARKETING_WEBHOOK_VERIFICATION_SIGNED_ACTION,
  marketingWebhookSignatureAuditRequirement,
  verifyMarketingAuditEvidence,
} from "@/lib/marketingAuditEvidence";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_WEBHOOK_RECORD_ID_PATTERN,
  MarketingWebhookVerificationRefusedError,
  checkMarketingWebhookRecordForSigning,
  readMarketingWebhookVerificationRecordFile,
  type MarketingWebhookVerificationSignature,
} from "@/lib/marketingWebhookVerification";

const schema = z
  .object({
    recordId: z.string().regex(MARKETING_WEBHOOK_RECORD_ID_PATTERN),
    /** The digest of the record's bytes the operator read and is signing. */
    recordDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const REFUSAL_STATUS: Record<string, number> = {
  record_id_invalid: 422,
  record_not_found: 404,
  record_invalid: 422,
  record_id_mismatch: 422,
  record_digest_mismatch: 409,
  record_pipeline_stale: 409,
  signature_audit_unverifiable: 503,
};

/**
 * POST: an operator signs one staging webhook verification record
 * (S2e-verification, S1 exact `marketing_webhook.verification_signed`).
 *
 * marketing:write and step-up through the shared runner. The record must be in
 * the deployed tree and its bytes must hash to the digest sent; the check runs
 * inside the transaction, after the audit row is written, so a refusal rolls
 * the row back with it. The answer is the sibling signature file's content.
 */
export async function POST(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_WEBHOOK_VERIFICATION_SIGNED_ACTION,
    targetType: "MarketingWebhookVerificationRecord",
    targetId: (body) => body.recordId,
    summary: "Signed a staging webhook verification record.",
    gate: "account_control",
    bucket: "admin-marketing-webhook-verification-sign",
    schema,
    metadata: (body) => ({ recordDigest: body.recordDigest }),
    refusal: (error) =>
      error instanceof MarketingWebhookVerificationRefusedError
        ? { code: error.code, status: REFUSAL_STATUS[error.code] ?? 409, message: error.message }
        : null,
    run: async (tx, { body, auditLogId }): Promise<MarketingWebhookVerificationSignature> => {
      checkMarketingWebhookRecordForSigning({
        recordId: body.recordId,
        recordDigest: body.recordDigest,
        fileText: await readMarketingWebhookVerificationRecordFile(body.recordId),
      });
      const signature = {
        recordId: body.recordId,
        recordDigest: body.recordDigest,
        signatureAuditLogId: auditLogId,
      };
      // The row just written, read back through the verifier the apply decision
      // uses. Without an audit integrity key the row is stored unhashed, and the
      // verifier refuses it for ever -- so a signature that "succeeded" here would
      // be one no apply could accept. Refusing rolls the row back with it.
      const verdict = await verifyMarketingAuditEvidence(
        tx,
        marketingWebhookSignatureAuditRequirement(signature),
      );
      if (!verdict.ok) {
        throw new MarketingWebhookVerificationRefusedError(
          "signature_audit_unverifiable",
          `The signing audit entry does not verify (${verdict.problem}).`,
        );
      }
      return signature;
    },
  });
}
