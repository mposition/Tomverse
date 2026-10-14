export const dynamic = "force-dynamic";

import { z } from "zod";

import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY,
  MARKETING_WEBHOOK_PRODUCTION_CONFIG_SIGNED_ACTION,
  MarketingWebhookProductionConfigRefusedError,
} from "@/lib/marketingWebhookProductionConfig";
import { signMarketingWebhookProductionConfig } from "@/lib/marketingWebhookProductionConfigStore";
import { MARKETING_WEBHOOK_RECORD_ID_PATTERN } from "@/lib/marketingWebhookVerification";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const schema = z
  .object({
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    recordId: z.string().regex(MARKETING_WEBHOOK_RECORD_ID_PATTERN),
    recordDigest: sha256Hex,
    verificationSignatureAuditLogId: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
    deployCommitSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    pipelineFingerprint: sha256Hex,
    productionConfigSnapshotDigest: sha256Hex,
  })
  .strict();

const REFUSAL_STATUS: Record<string, number> = {
  environment_not_production: 409,
  record_not_found: 404,
  record_invalid: 422,
  record_digest_mismatch: 409,
  record_pipeline_stale: 409,
  record_signature_unverified: 409,
  pipeline_fingerprint_changed: 409,
  deploy_commit_unknown: 503,
  deploy_commit_changed: 409,
  config_snapshot_changed: 409,
  production_config_unreadable: 500,
  production_config_conflict: 409,
  signature_audit_unverifiable: 503,
};

/**
 * POST: an operator signs one production webhook configuration generation
 * (S2f gate, `marketing_webhook.production_config_signed`, S1 r7 amendment 1).
 *
 * marketing:write and step-up through the shared runner; the kill switch stops
 * it, because a signature is what lets production apply events. The audit row
 * binds every signed field from the request, and the store recomputes each of
 * them inside the same transaction and refuses one that moved -- so the row can
 * only commit when it describes what was actually written.
 */
export async function POST(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_WEBHOOK_PRODUCTION_CONFIG_SIGNED_ACTION,
    targetType: "AppSetting",
    targetId: MARKETING_WEBHOOK_PRODUCTION_CONFIG_KEY,
    summary: (body) => `Signed production webhook configuration generation ${body.generation}.`,
    gate: "account_control",
    bucket: "admin-marketing-webhook-production-config-sign",
    schema,
    metadata: (body) => ({
      generation: body.generation,
      recordId: body.recordId,
      recordDigest: body.recordDigest,
      verificationSignatureAuditLogId: body.verificationSignatureAuditLogId,
      deployCommitSha: body.deployCommitSha,
      pipelineFingerprint: body.pipelineFingerprint,
      productionConfigSnapshotDigest: body.productionConfigSnapshotDigest,
    }),
    refusal: (error) =>
      error instanceof MarketingWebhookProductionConfigRefusedError
        ? { code: error.code, status: REFUSAL_STATUS[error.code] ?? 409, message: error.message }
        : null,
    run: async (tx, { body, auditLogId }) => signMarketingWebhookProductionConfig(tx, body, auditLogId),
  });
}
