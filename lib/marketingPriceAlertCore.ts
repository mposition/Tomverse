/**
 * Whether the price-source alert can be delivered (S3 plan, S3d;
 * docs/policy/marketing-automation.md §7.2(2)). Pure: no import but a type, so
 * the Guard's context, the draft intake and the autonomous admission can all
 * read it without pulling the alert transport in.
 *
 * The alert goes through the operational alert path (decision D5,
 * 2026-10-17), which sends to `OPS_ALERT_EMAIL`, else `ADMIN_ALERT_EMAIL`. So
 * ready means one of those is set. Until then the Guard keeps every draft that
 * names a price claim in the approval queue (`alert_path_not_ready`) and the
 * generator's draft intake stays closed.
 */

import type { ReadResult } from "./marketingAutomationAccess.ts";

/**
 * The operational alert's recipient variables, in its order. lib/operationalMonitoring.ts
 * reads them privately; tests/marketingPriceAlert.test.mjs fails if the two lists part.
 */
export const MARKETING_PRICE_ALERT_RECIPIENT_ENVS = ["OPS_ALERT_EMAIL", "ADMIN_ALERT_EMAIL"] as const;

/** The Guard's refusal code the alert answers. */
export const MARKETING_PRICE_SOURCE_REFUSAL_CODE = "price_source_not_stored";

/**
 * Whether the operational alert path has a recipient, decided the way it
 * decides: the first variable that is set at all wins, and only then is it
 * trimmed. A blank `OPS_ALERT_EMAIL` therefore means no recipient even when
 * `ADMIN_ALERT_EMAIL` is set -- the alert would go nowhere, so this is not ready.
 */
export function marketingPriceAlertReady(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return Boolean((env.OPS_ALERT_EMAIL || env.ADMIN_ALERT_EMAIL)?.trim());
}

/** The same, as the access resolver's input. Reading an environment variable cannot fail. */
export function marketingPriceAlertReadyInput(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadResult<boolean> {
  return { ok: true, value: marketingPriceAlertReady(env) };
}
