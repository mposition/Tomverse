import "server-only";

import { sign } from "node:crypto";
import { isAnalyticsUserId } from "@/lib/ga4UserIdPolicy";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

/**
 * Asks GA4 to delete what it holds under a stored User-ID, when analytics
 * consent is withdrawn or the account is deleted
 * (docs/policy/marketing-automation.md §10.2, §12.2).
 *
 * Google Analytics Admin API `properties.submitUserDeletion` (v1alpha, scope
 * `analytics.edit`), authenticated as a service account that has the Editor
 * role on the property. Credentials are environment variables and nothing
 * else:
 *
 * - `GA4_PROPERTY_ID` -- the numeric property id;
 * - `GA4_USER_DELETION_SERVICE_ACCOUNT_JSON` (or `..._BASE64`) -- the service
 *   account key.
 *
 * Never part of the deletion it follows and never in its way: it cannot undo
 * anything and never throws, and the caller deletes the stored id whatever it
 * returns. One attempt. A refusal or an unknown outcome is reported as an
 * operational incident -- without the id, which must not outlive its row in a log --
 * and not retried blindly; submitting the same deletion twice is harmless,
 * but a blind retry loop on an unknown outcome is not how this repository
 * treats an external write.
 */

/** The environment these read: `process.env`, or a plain map in a test. */
export type Ga4Env = Readonly<Record<string, string | undefined>>;

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ANALYTICS_EDIT_SCOPE = "https://www.googleapis.com/auth/analytics.edit";
const TIMEOUT_MS = 5_000;

export const GA4_USER_DELETION_ENV = {
  propertyId: "GA4_PROPERTY_ID",
  serviceAccountJson: "GA4_USER_DELETION_SERVICE_ACCOUNT_JSON",
  serviceAccountJsonBase64: "GA4_USER_DELETION_SERVICE_ACCOUNT_JSON_BASE64",
} as const;

export type Ga4UserDeletionOutcome =
  | { status: "submitted"; deletionRequestTime: string | null }
  | { status: "not_configured" }
  | { status: "refused"; stage: "token" | "deletion"; httpStatus: number }
  | { status: "unknown"; stage: "token" | "deletion" };

type Deps = {
  fetch: typeof fetch;
  env: Ga4Env;
  now: () => Date;
};

const defaultDeps = (): Deps => ({ fetch, env: process.env, now: () => new Date() });

const base64Url = (value: string | Uint8Array) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

type ServiceAccount = { client_email: string; private_key: string };

const serviceAccount = (env: Ga4Env): ServiceAccount | null => {
  const json = env[GA4_USER_DELETION_ENV.serviceAccountJson]?.trim();
  const base64 = env[GA4_USER_DELETION_ENV.serviceAccountJsonBase64]?.trim();
  if (!json && !base64) return null;
  try {
    const parsed = JSON.parse(
      json || Buffer.from(base64 as string, "base64").toString("utf8")
    ) as Record<string, unknown>;
    if (
      typeof parsed.client_email !== "string" ||
      !parsed.client_email.trim() ||
      typeof parsed.private_key !== "string" ||
      !parsed.private_key.includes("PRIVATE KEY")
    ) {
      return null;
    }
    return { client_email: parsed.client_email.trim(), private_key: parsed.private_key };
  } catch {
    return null;
  }
};

const propertyId = (env: Ga4Env) => {
  const value = env[GA4_USER_DELETION_ENV.propertyId]?.trim();
  return value && /^[0-9]{1,20}$/.test(value) ? value : null;
};

export const ga4UserDeletionConfigured = (env: Ga4Env = process.env) =>
  propertyId(env) !== null && serviceAccount(env) !== null;

/** Submits one User-ID deletion. Never throws. */
export async function submitGa4UserDeletion(
  analyticsUserId: string,
  deps: Deps = defaultDeps()
): Promise<Ga4UserDeletionOutcome> {
  const property = propertyId(deps.env);
  const account = serviceAccount(deps.env);
  if (!property || !account) return { status: "not_configured" };

  let accessToken: string;
  try {
    const issuedAt = Math.floor(deps.now().getTime() / 1_000);
    const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
      JSON.stringify({
        iss: account.client_email,
        scope: ANALYTICS_EDIT_SCOPE,
        aud: GOOGLE_OAUTH_TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + 3_600,
      })
    )}`;
    const signature = sign("RSA-SHA256", Buffer.from(unsigned, "utf8"), account.private_key);
    const response = await deps.fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${base64Url(signature)}`,
      }),
    });
    const payload = (await response.json().catch(() => null)) as {
      access_token?: unknown;
    } | null;
    if (!response.ok || typeof payload?.access_token !== "string" || !payload.access_token) {
      return { status: "refused", stage: "token", httpStatus: response.status };
    }
    accessToken = payload.access_token;
  } catch {
    return { status: "unknown", stage: "token" };
  }

  try {
    const response = await deps.fetch(
      `https://analyticsadmin.googleapis.com/v1alpha/properties/${property}:submitUserDeletion`,
      {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: analyticsUserId }),
      }
    );
    const payload = (await response.json().catch(() => null)) as {
      deletionRequestTime?: unknown;
    } | null;
    if (!response.ok) {
      return { status: "refused", stage: "deletion", httpStatus: response.status };
    }
    return {
      status: "submitted",
      deletionRequestTime:
        typeof payload?.deletionRequestTime === "string" ? payload.deletionRequestTime : null,
    };
  } catch {
    return { status: "unknown", stage: "deletion" };
  }
}

/** Why a stored id is being deleted; reported with a failure, never the id. */
export type Ga4UserIdDeletionTrigger = "consent_withdrawal" | "account_deletion";

/**
 * Asks GA4 to delete a stored User-ID's data, once. Only an id that was
 * stored can be named here, and a stored id is the evidence that one may have
 * been sent: no other gate, so an id created while the switch was on is still
 * deleted after it is turned off. An incident when the request was not
 * submitted -- credentials missing included, since an id exists that cannot
 * be deleted. Never throws.
 */
export async function requestGa4UserIdDeletion(
  analyticsUserId: string,
  trigger: Ga4UserIdDeletionTrigger,
  deps: Deps = defaultDeps()
): Promise<Ga4UserDeletionOutcome> {
  if (!isAnalyticsUserId(analyticsUserId)) return { status: "not_configured" };
  const outcome = await submitGa4UserDeletion(analyticsUserId, deps).catch(
    (): Ga4UserDeletionOutcome => ({ status: "unknown", stage: "deletion" })
  );
  if (outcome.status !== "submitted") {
    await reportOperationalIncident({
      code:
        outcome.status === "not_configured"
          ? "GA4_USER_DELETION_NOT_CONFIGURED"
          : "GA4_USER_DELETION_FAILED",
      title: "GA4 User-ID deletion request was not submitted",
      error:
        outcome.status === "not_configured"
          ? "A stored GA4 User-ID is being deleted but GA4 deletion credentials are not set."
          : `GA4 user deletion ${outcome.status} at the ${outcome.stage} stage.`,
      severity: "warning",
      context: {
        component: "ga4-user-deletion",
        trigger,
        status: outcome.status,
        stage: "stage" in outcome ? outcome.stage : "none",
        httpStatus: "httpStatus" in outcome ? String(outcome.httpStatus) : "none",
      },
    }).catch(() => undefined);
  }
  return outcome;
}
