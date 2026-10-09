export const dynamic = "force-dynamic";

import { z } from "zod";

import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import { MARKETING_S2E_ACTIONS } from "@/lib/marketingStore";
import {
  MARKETING_WEBHOOK_FAULT_ARM_KEY,
  MARKETING_WEBHOOK_PROVIDER,
  MarketingWebhookSettingRefusedError,
  marketingWebhookEventIdDigest,
} from "@/lib/marketingWebhookCore";
import { setMarketingWebhookFaultArm } from "@/lib/marketingWebhookSettings";

const schema = z
  .object({
    /** The one event this arm fails, as `sha256(provider, eventId)`, lowercase hex. */
    eventIdDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /**
     * Or Zernio's own event id, as its webhook log shows it. Condition 4 needs an
     * event that was delivered but never processed (the shadow was off), and such
     * an event has no shadow report to arm from; the digest is computed here.
     */
    eventId: z.string().uuid().optional(),
    /** The arm generation the screen read; 0 when none has ever been set. */
    expectedGeneration: z.number().int().nonnegative(),
    /** How long the arm stays armed, at most a day. */
    ttlMinutes: z.number().int().min(1).max(24 * 60),
  })
  .strict()
  .refine((body) => (body.eventIdDigest === undefined) !== (body.eventId === undefined), {
    message: "Name the event by exactly one of eventIdDigest or eventId.",
  });

const digestOf = (body: z.infer<typeof schema>): string =>
  body.eventIdDigest ?? marketingWebhookEventIdDigest(MARKETING_WEBHOOK_PROVIDER, body.eventId ?? "");

const REFUSAL_STATUS: Record<string, number> = {
  environment_not_staging: 409,
  fault_arm_conflict: 409,
  fault_arm_digest_invalid: 422,
  fault_arm_ttl_invalid: 422,
  fault_arm_unreadable: 500,
  database_clock_unavailable: 503,
};

/**
 * POST: an operator arms one deliberate webhook failure for exactly one event
 * (S2e `marketing_webhook.fault_arm_set`).
 *
 * Staging exactly; marketing:write and step-up through the shared runner; the
 * arm and the human audit entry commit together. The receiver consumes it in a
 * separate transaction and answers that one delivery 5xx, so the provider's
 * retry -- and its dedupe -- can be observed.
 */
export async function POST(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_S2E_ACTIONS.faultArmSet,
    targetType: "AppSetting",
    targetId: MARKETING_WEBHOOK_FAULT_ARM_KEY,
    summary: "Armed one deliberate webhook failure in staging.",
    gate: "account_control",
    bucket: "admin-marketing-webhook-fault-arm",
    schema,
    metadata: (body) => ({
      eventIdDigest: digestOf(body),
      expectedGeneration: body.expectedGeneration,
      ttlMinutes: body.ttlMinutes,
    }),
    refusal: (error) =>
      error instanceof MarketingWebhookSettingRefusedError
        ? { code: error.code, status: REFUSAL_STATUS[error.code] ?? 409, message: error.message }
        : null,
    run: async (tx, { body }) =>
      setMarketingWebhookFaultArm(tx, {
        eventIdDigest: digestOf(body),
        expectedGeneration: body.expectedGeneration,
        ttlMs: body.ttlMinutes * 60 * 1000,
      }),
  });
}
