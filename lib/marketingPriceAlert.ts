/**
 * The operator alert a price-source refusal raises (S3 plan, S3d;
 * docs/policy/marketing-automation.md §7.2(2): "하나라도 아니면 거절하고 운영자에게 경보한다").
 *
 * Delivered through the existing operational alert path
 * (`reportOperationalIncident()`, lib/operationalMonitoring.ts) -- a direct
 * send to `OPS_ALERT_EMAIL` and any configured chat webhook, not the email
 * outbox. The operator chose this path on 2026-10-17 (decision D5). The body
 * is a link to the Admin console and the post's id, nothing else: no draft
 * words, no claim text, no price. Whether the path is ready is
 * lib/marketingPriceAlertCore.ts.
 */

import "server-only";

import { reportOperationalIncident } from "@/lib/operationalMonitoring";

/** The incident code a refusal is reported under. */
export const MARKETING_PRICE_ALERT_INCIDENT_CODE = "MARKETING_PRICE_SOURCE_NOT_STORED";

const adminConsoleUrl = (env: Readonly<Record<string, string | undefined>>) =>
  `${(env.PUBLIC_APP_URL || env.NEXT_PUBLIC_APP_URL || "https://tomverse.app").replace(/\/+$/u, "")}/admin/marketing`;

/**
 * Tell the operator a generated draft was refused for resting on a price that
 * is not a stored value. Never throws: a failed alert is logged, and the
 * refusal it describes is already recorded with its audit row.
 */
export async function reportMarketingPriceSourceRefusal(
  input: { readonly postId: string },
  deps: {
    readonly report?: typeof reportOperationalIncident;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  try {
    await (deps.report ?? reportOperationalIncident)({
      code: MARKETING_PRICE_ALERT_INCIDENT_CODE,
      title: "A generated marketing draft was refused: a price it names is not a stored value",
      severity: "warning",
      // Every refusal is a different post the operator has to look at; the
      // per-code cooldown would deliver the first of a burst and drop the rest,
      // and a dropped one is never raised again.
      forceNotification: true,
      context: { component: "marketing-guard", postId: input.postId, admin: adminConsoleUrl(env) },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "marketing_price_alert_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}
