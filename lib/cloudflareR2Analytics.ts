/**
 * The one Cloudflare R2 analytics read, so the probe and the credential check
 * ask the same question.
 *
 * This exists because of a three-day production incident: the threshold
 * monitor paged `INFRASTRUCTURE_R2_ERROR` (fatal) every thirty minutes with
 * Cloudflare's own sentence, "not authorized for that account", and there was
 * no way to find out which credential it meant without editing the server.
 * `scripts/check-cloudflare-r2-analytics.mjs` answers that from a shell, and
 * it is only worth trusting if it sends the query the probe sends -- a check
 * that reproduces the request approximately proves nothing about the request
 * that actually failed.
 *
 * Deliberately free of `server-only`, Prisma and Next.js: a script has to be
 * able to import it.
 */

export const CLOUDFLARE_GRAPHQL_URL =
  "https://api.cloudflare.com/client/v4/graphql";

/**
 * Cloudflare's analytics schema declares its own lowercase scalars (`string`,
 * `uint64`, `Time`); `String!` here is a validation error, not a style choice.
 */
export const R2_ANALYTICS_QUERY = `
  query TomverseR2Audit(
    $accountTag: string!
    $startDate: Time!
    $endDate: Time!
    $bucketName: string!
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        storage: r2StorageAdaptiveGroups(
          limit: 1
          filter: {
            datetime_geq: $startDate
            datetime_leq: $endDate
            bucketName: $bucketName
          }
          orderBy: [datetime_DESC]
        ) {
          max { objectCount uploadCount payloadSize metadataSize }
          dimensions { datetime }
        }
        operations: r2OperationsAdaptiveGroups(
          limit: 1000
          filter: {
            datetime_geq: $startDate
            datetime_leq: $endDate
            bucketName: $bucketName
          }
        ) {
          sum { requests }
          dimensions { actionType }
        }
      }
    }
  }
`;

/**
 * Whether the token can see the account at all, asked without naming a
 * dataset.
 *
 * This is the discriminator the incident lacked. `R2_ANALYTICS_QUERY` failing
 * has two unrelated causes -- the token is not scoped to `R2_ACCOUNT_ID`, or
 * it is scoped there but cannot read the R2 datasets -- and Cloudflare
 * answers both with the same sentence. Running this one first separates them.
 */
export const CLOUDFLARE_ACCOUNT_SCOPE_QUERY = `
  query TomverseAccountScope($accountTag: string!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        accountTag
      }
    }
  }
`;

/**
 * Did the Cloudflare API answer, or did something in front of it?
 *
 * Every Cloudflare REST response -- success or failure -- carries `success`
 * and `errors`; every GraphQL response carries `data` or `errors`. An egress
 * proxy, a corporate gateway or a captive portal answers 403 with its own
 * body and none of those fields.
 *
 * Without this distinction a credential check reports "your token is invalid,
 * reissue it" at a host that was simply blocked -- the same species of
 * misdirection as the alert this module exists to replace. Both shapes were
 * observed: a blocked sandbox answers `403 Host not in allowlist:
 * api.cloudflare.com` with no envelope at all.
 */
export const isCloudflareRestEnvelope = (payload: unknown) =>
  Boolean(payload) &&
  typeof payload === "object" &&
  ("success" in (payload as object) ||
    Array.isArray((payload as { errors?: unknown }).errors));

export const isCloudflareGraphqlEnvelope = (payload: unknown) =>
  Boolean(payload) &&
  typeof payload === "object" &&
  ("data" in (payload as object) ||
    Array.isArray((payload as { errors?: unknown }).errors));

export const cloudflareGraphqlErrorMessages = (payload: unknown): string[] =>
  Array.isArray((payload as { errors?: unknown[] })?.errors)
    ? (payload as { errors: Array<{ message?: unknown }> }).errors
        .map((entry) =>
          typeof entry?.message === "string" ? entry.message : ""
        )
        .filter(Boolean)
    : [];

export type CloudflareGraphqlFailure =
  | "intercepted"
  | "account_not_authorized"
  | "token_rejected"
  | "query_rejected"
  | null;

/**
 * Which of the mutually exclusive causes produced this GraphQL answer.
 *
 * `not authorized for that account` is the sentence production reported for
 * three days, and on its own it does not distinguish a token scoped to the
 * wrong account from a token with no analytics permission on the right one.
 * Which of those it is depends on *where* the sentence appears: from the
 * account-scope query it is the account, from the R2 dataset query -- after
 * the scope query succeeded -- it is the permission. Callers supply that
 * ordering; this function reports the cause honestly and never guesses.
 *
 * Returns null when there is no failure to classify.
 */
export const classifyCloudflareGraphqlFailure = (
  payload: unknown,
  httpOk: boolean
): CloudflareGraphqlFailure => {
  if (!isCloudflareGraphqlEnvelope(payload)) return "intercepted";
  const message = cloudflareGraphqlErrorMessages(payload).join("; ");
  if (!message) return httpOk ? null : "query_rejected";
  if (/not authorized for that account/i.test(message)) {
    return "account_not_authorized";
  }
  if (
    /authentication error|invalid api token|invalid request headers/i.test(
      message
    )
  ) {
    return "token_rejected";
  }
  // A schema or validation error is not a permission answer, and reporting it
  // as one sends the operator to rotate a token that is fine.
  return "query_rejected";
};

/**
 * The window the probe reads: month-to-date, matching the free-tier
 * allowances the dashboard compares against.
 */
export const r2AnalyticsVariables = (
  accountTag: string,
  bucketName: string,
  now = new Date()
) => ({
  accountTag,
  startDate: new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  ).toISOString(),
  endDate: now.toISOString(),
  bucketName,
});
