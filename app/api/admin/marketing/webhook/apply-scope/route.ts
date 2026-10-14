export const dynamic = "force-dynamic";

import { z } from "zod";

import { MARKETING_WEBHOOK_APPLY_SCOPE_KEY } from "@/lib/marketingAutomationAccess";
import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_WEBHOOK_APPLY_SCOPE_CHANGED_ACTION,
  MarketingWebhookProductionConfigRefusedError,
  serializeMarketingWebhookProductionApplyScope,
} from "@/lib/marketingWebhookProductionConfig";
import { setMarketingWebhookProductionApplyScope } from "@/lib/marketingWebhookProductionConfigStore";
import { MARKETING_WEBHOOK_RECORD_ID_PATTERN } from "@/lib/marketingWebhookVerification";
import { createHash } from "node:crypto";

const boundedToken = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

const schema = z
  .object({
    recordId: z.string().regex(MARKETING_WEBHOOK_RECORD_ID_PATTERN),
    productionConfigGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    scope: z.array(z.object({ eventType: boundedToken, channelId: boundedToken }).strict()).max(200),
    /** `absent`, or the sha-256 of the stored value the screen read. */
    expectedStoredDigest: z.union([z.literal("absent"), z.string().regex(/^[0-9a-f]{64}$/)]),
  })
  .strict();

const REFUSAL_STATUS: Record<string, number> = {
  environment_not_production: 409,
  apply_scope_invalid: 422,
  production_config_mismatch: 409,
  production_config_not_binding: 409,
  record_invalid: 422,
  scope_not_observed: 422,
  apply_scope_conflict: 409,
  apply_scope_noop: 409,
};

const scopeDigest = (body: z.infer<typeof schema>): string => {
  try {
    return createHash("sha256")
      .update(
        serializeMarketingWebhookProductionApplyScope({
          recordId: body.recordId,
          productionConfigGeneration: body.productionConfigGeneration,
          scope: body.scope,
        }),
        "utf8",
      )
      .digest("hex");
  } catch {
    // A duplicate pair: the store refuses it with its own code.
    return "invalid";
  }
};

/**
 * PUT: an operator sets which exact (event type, channel) pairs production may
 * apply (S2f, `marketing_webhook.apply_scope_changed`).
 *
 * marketing:write and step-up through the shared runner. An empty scope is a
 * stop and is never gated; a non-empty one starts production applying events
 * and is stopped by the kill switch. The audit row binds the record, the signed
 * generation, the digest of the exact stored value and the value it replaced.
 */
export async function PUT(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_WEBHOOK_APPLY_SCOPE_CHANGED_ACTION,
    targetType: "AppSetting",
    targetId: MARKETING_WEBHOOK_APPLY_SCOPE_KEY,
    summary: (body) =>
      body.scope.length === 0
        ? "Emptied the production webhook apply scope."
        : `Set the production webhook apply scope to ${body.scope.length} pair(s).`,
    gate: (body) => (body.scope.length === 0 ? "operator_restriction" : "account_control"),
    bucket: "admin-marketing-webhook-apply-scope",
    schema,
    metadata: (body) => ({
      recordId: body.recordId,
      productionConfigGeneration: body.productionConfigGeneration,
      scopeSize: body.scope.length,
      scopeDigest: scopeDigest(body),
      expectedStoredDigest: body.expectedStoredDigest,
    }),
    refusal: (error) =>
      error instanceof MarketingWebhookProductionConfigRefusedError
        ? { code: error.code, status: REFUSAL_STATUS[error.code] ?? 409, message: error.message }
        : null,
    run: async (tx, { body }) => setMarketingWebhookProductionApplyScope(tx, body),
  });
}
