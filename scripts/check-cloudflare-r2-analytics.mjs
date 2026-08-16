// Can this Cloudflare token read R2 usage analytics for this account?
//
//   npm run check:cloudflare-r2-analytics
//   npm run check:cloudflare-r2-analytics -- --json
//
// Written after INFRASTRUCTURE_R2_ERROR paged production for three days with
// Cloudflare's own eight-word sentence, "not authorized for that account", and
// nothing else. That sentence has at least four unrelated causes, and the
// alert distinguished none of them:
//
//   * CLOUDFLARE_API_TOKEN was revoked, expired, or replaced
//   * the token is live but scoped to a different Cloudflare account
//   * the token is scoped to this account but lacks Account Analytics: Read
//   * R2_ACCOUNT_ID no longer names the account the bucket lives in
//
// The last one is the quiet failure mode. R2_ACCOUNT_ID is only used to build
// the S3 endpoint when R2_ENDPOINT is unset, so where R2_ENDPOINT *is* set --
// production sets it -- the account id can drift to a wrong value and every
// upload keeps working. Only the analytics probe, which passes it as the
// GraphQL accountTag, ever notices.
//
// Three reads, each answering one question, so a failure lands on one line:
//
//   1. GET /user/tokens/verify   is the token itself live?
//   2. accounts(accountTag)      can it see this account at all?
//   3. the R2 datasets           can it read R2 storage and operations?
//
// Read-only, unbilled, and writes nothing anywhere. Safe to run against a
// candidate token before deploying it: export the four variables in a shell
// and run this rather than deploying and watching Sentry.
//
// This is an operational check against a live account, not a PR gate. It is
// not wired into any CI workflow, and an environment with no token configured
// exits 0 with "not configured" rather than failing a build.

import {
  CLOUDFLARE_ACCOUNT_SCOPE_QUERY,
  CLOUDFLARE_GRAPHQL_URL,
  R2_ANALYTICS_QUERY,
  classifyCloudflareGraphqlFailure,
  cloudflareGraphqlErrorMessages,
  isCloudflareRestEnvelope,
  r2AnalyticsVariables,
} from "../lib/cloudflareR2Analytics.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");

// Read exactly as lib/infrastructureMonitoring.ts reads them, trim included.
// A check that normalises differently from the probe is checking a different
// configuration than the one that failed.
const accountId = process.env.R2_ACCOUNT_ID?.trim();
const bucketName = process.env.R2_BUCKET_NAME?.trim();
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();

const TOKEN_VERIFY_URL = "https://api.cloudflare.com/client/v4/user/tokens/verify";
const TIMEOUT_MS = 15_000;

/**
 * A Cloudflare token is a 40-character opaque string that turns up in echoed
 * request headers and in some error bodies. This output is meant to be pasted
 * into an operational ticket, so nothing leaves here without passing through.
 */
const redact = (text) =>
  String(text)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");

const summarise = (text) => {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length > 240 ? `${clean.slice(0, 240)}...` : clean;
};

// The account id is not a secret -- it is in every R2 endpoint hostname -- but
// the operator needs to compare it against the Cloudflare dashboard, and the
// full value in a pasted ticket helps nobody do that any faster.
const maskAccount = (value) =>
  value.length <= 10 ? value : `${value.slice(0, 4)}...${value.slice(-4)}`;

const post = async (url, body) => {
  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // Left null; the caller reports the body instead of a parse failure.
    }
    return { status: response.status, ok: response.ok, text, payload };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      text: "",
      payload: null,
      networkError: summarise(error?.message || String(error)),
    };
  }
};

const restErrors = (payload) =>
  Array.isArray(payload?.errors)
    ? payload.errors
        .map((entry) =>
          typeof entry?.message === "string"
            ? `${entry.code ?? "?"}: ${entry.message}`
            : ""
        )
        .filter(Boolean)
    : [];

const result = {
  checkedAt: new Date().toISOString(),
  configured: {
    R2_ACCOUNT_ID: accountId ? maskAccount(accountId) : null,
    R2_BUCKET_NAME: bucketName || null,
    CLOUDFLARE_API_TOKEN: token ? "set" : null,
  },
  steps: [],
  verdict: null,
  remedy: null,
};

const step = (name, ok, code, detail) => {
  result.steps.push({ name, ok, code, detail });
  return ok;
};

const finish = (verdict, remedy, exitCode) => {
  result.verdict = verdict;
  result.remedy = remedy;
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("Cloudflare R2 usage analytics check\n");
    console.log(`  checked:         ${result.checkedAt}`);
    console.log(`  R2_ACCOUNT_ID:   ${result.configured.R2_ACCOUNT_ID ?? "(unset)"}`);
    console.log(`  R2_BUCKET_NAME:  ${result.configured.R2_BUCKET_NAME ?? "(unset)"}`);
    console.log(
      `  CLOUDFLARE_API_TOKEN: ${result.configured.CLOUDFLARE_API_TOKEN ?? "(unset)"}\n`
    );
    for (const entry of result.steps) {
      console.log(`  ${entry.ok ? "ok  " : "FAIL"} ${entry.name}  [${entry.code}]`);
      if (entry.detail) console.log(`       ${entry.detail}`);
    }
    console.log(`\n  ${verdict}`);
    if (remedy) console.log(`\n  ${remedy}`);
  }
  process.exit(exitCode);
};

// ---------------------------------------------------------------------------
// Step 0: is there anything to check?
// ---------------------------------------------------------------------------
if (!accountId || !bucketName || !token) {
  const missing = [
    !accountId && "R2_ACCOUNT_ID",
    !bucketName && "R2_BUCKET_NAME",
    !token && "CLOUDFLARE_API_TOKEN",
  ].filter(Boolean);
  step("configuration", false, "not_configured", `Unset: ${missing.join(", ")}.`);
  // The probe reports this state as `unconfigured`, which raises no incident.
  // Exiting non-zero here would turn "analytics are deliberately off in this
  // environment" into a failure, so it does not.
  finish(
    "Not configured, so nothing was checked. The probe reports this as `unconfigured` and raises no incident.",
    "Set the missing variables to enable the R2 analytics probe. Uploads do not depend on CLOUDFLARE_API_TOKEN.",
    0
  );
}

// ---------------------------------------------------------------------------
// Step 1: is the token itself live? Permission-free, so it separates "the
// token is gone" from every scope question below.
// ---------------------------------------------------------------------------
const verify = await post(TOKEN_VERIFY_URL, null);
if (verify.networkError !== undefined) {
  step("token verify", false, "network_error", verify.networkError);
  finish(
    "Cloudflare did not answer, so nothing about the token was established.",
    "Retry. If this persists, check egress from wherever you ran it -- this says nothing about the token.",
    1
  );
}
if (!verify.ok && !isCloudflareRestEnvelope(verify.payload)) {
  step(
    "token verify",
    false,
    `intercepted_http_${verify.status}`,
    summarise(verify.text)
  );
  finish(
    `Something other than the Cloudflare API answered with ${verify.status}, so nothing about the token was established.`,
    "Run this where egress to api.cloudflare.com is permitted. Nothing above says the token is wrong.",
    1
  );
}
if (!verify.ok) {
  const detail = restErrors(verify.payload).join("; ") || summarise(verify.text);
  step("token verify", false, `http_${verify.status}`, detail);
  finish(
    "CLOUDFLARE_API_TOKEN was rejected: the token is invalid, revoked or expired.",
    "Issue a new API token scoped to the account holding the bucket, with Account Analytics: Read, and set CLOUDFLARE_API_TOKEN to it.",
    1
  );
}
const tokenStatus = verify.payload?.result?.status ?? "unknown";
if (tokenStatus !== "active") {
  step("token verify", false, `status_${tokenStatus}`, "Token is not active.");
  finish(
    `CLOUDFLARE_API_TOKEN exists but its status is "${tokenStatus}".`,
    "Reactivate or reissue the token in the Cloudflare dashboard under My Profile > API Tokens.",
    1
  );
}
step("token verify", true, "active", "The token itself is live.");

// ---------------------------------------------------------------------------
// Step 2: can it see this account? This is the step that names R2_ACCOUNT_ID
// as the suspect rather than the token.
// ---------------------------------------------------------------------------
const scope = await post(CLOUDFLARE_GRAPHQL_URL, {
  query: CLOUDFLARE_ACCOUNT_SCOPE_QUERY,
  variables: { accountTag: accountId },
});
if (scope.networkError !== undefined) {
  step("account scope", false, "network_error", scope.networkError);
  finish("Cloudflare did not answer the account-scope query.", "Retry.", 1);
}
const scopeMessage = summarise(
  cloudflareGraphqlErrorMessages(scope.payload).join("; ") || scope.text
);
const scopeFailure = classifyCloudflareGraphqlFailure(scope.payload, scope.ok);
if (scopeFailure === "intercepted") {
  step("account scope", false, `intercepted_http_${scope.status}`, scopeMessage);
  finish(
    "The GraphQL endpoint's answer was not a GraphQL response, so no permission question was answered.",
    "Run this where egress to api.cloudflare.com is permitted.",
    1
  );
}
if (scopeFailure === "account_not_authorized") {
  step("account scope", false, "account_not_authorized", scopeMessage);
  finish(
    `The token is live, but it is not authorized for account ${maskAccount(accountId)}. ` +
      "This is the production failure: either the token belongs to a different Cloudflare account, or it carries no account-level analytics permission on this one.",
    "Confirm the account id against the bucket in the Cloudflare dashboard and set R2_ACCOUNT_ID to it; then reissue CLOUDFLARE_API_TOKEN on THAT account with Account Analytics: Read. Uploads are unaffected either way -- they use R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY against R2_ENDPOINT.",
    1
  );
}
if (scopeFailure === "token_rejected") {
  step("account scope", false, "token_rejected_by_graphql", scopeMessage);
  finish(
    "The token verified but the GraphQL Analytics API rejected it.",
    "Reissue the token with Account Analytics: Read.",
    1
  );
}
if (scopeFailure === "query_rejected") {
  step("account scope", false, "probe_query_rejected", scopeMessage);
  finish(
    "Cloudflare rejected the account-scope query itself, so nothing about permissions was established.",
    "This is a query problem, not a credential problem. Check lib/cloudflareR2Analytics.ts against Cloudflare's current analytics schema.",
    1
  );
}

const accounts = scope.payload?.data?.viewer?.accounts;
if (!Array.isArray(accounts) || accounts.length === 0) {
  step(
    "account scope",
    false,
    "account_not_visible",
    "The query succeeded and returned no account for this tag."
  );
  finish(
    `No account matched R2_ACCOUNT_ID (${maskAccount(accountId)}) for this token.`,
    "R2_ACCOUNT_ID does not name an account this token can see. Copy the account id from the R2 bucket's page in the Cloudflare dashboard. Note that a wrong R2_ACCOUNT_ID is invisible to uploads whenever R2_ENDPOINT is set.",
    1
  );
}
step("account scope", true, "visible", "The token can see this account.");

// ---------------------------------------------------------------------------
// Step 3: the read the probe actually makes.
// ---------------------------------------------------------------------------
const analytics = await post(CLOUDFLARE_GRAPHQL_URL, {
  query: R2_ANALYTICS_QUERY,
  variables: r2AnalyticsVariables(accountId, bucketName),
});
if (analytics.networkError !== undefined) {
  step("r2 datasets", false, "network_error", analytics.networkError);
  finish("Cloudflare did not answer the R2 analytics query.", "Retry.", 1);
}
const analyticsMessage =
  summarise(
    cloudflareGraphqlErrorMessages(analytics.payload).join("; ") ||
      analytics.text
  ) || `Cloudflare returned ${analytics.status}.`;
const analyticsFailure = classifyCloudflareGraphqlFailure(
  analytics.payload,
  analytics.ok
);
if (analyticsFailure === "intercepted") {
  step(
    "r2 datasets",
    false,
    `intercepted_http_${analytics.status}`,
    analyticsMessage
  );
  finish(
    "The GraphQL endpoint's answer was not a GraphQL response, so the R2 datasets were never reached.",
    "Run this where egress to api.cloudflare.com is permitted.",
    1
  );
}
if (analyticsFailure !== null) {
  step("r2 datasets", false, analyticsFailure, analyticsMessage);
  // Step 2 already resolved the account, so the same sentence that was
  // ambiguous there is unambiguous here: the account is right and the
  // permission is missing.
  finish(
    "The token can see the account but cannot read the R2 analytics datasets. This is the exact read the threshold monitor makes, and the exact message it reports.",
    "Add Account Analytics: Read to the token for this account. Reaching this line means R2_ACCOUNT_ID is correct -- the account resolved in step 2 -- so do not change it.",
    1
  );
}

const account = analytics.payload?.data?.viewer?.accounts?.[0];
const storageRows = account?.storage?.length ?? 0;
const operationRows = account?.operations?.length ?? 0;
step(
  "r2 datasets",
  true,
  "readable",
  `storage rows: ${storageRows}, operation rows: ${operationRows}.`
);

if (storageRows === 0 && operationRows === 0) {
  // Readable but empty. Reported rather than passed off as healthy: an
  // unknown bucket name and a genuinely idle bucket look identical here, and
  // the probe would report 0 bytes for both.
  finish(
    `The credentials work, but neither dataset returned a row for bucket "${bucketName}" this month. A misspelled bucket name and an untouched bucket are indistinguishable from here.`,
    "Confirm R2_BUCKET_NAME against the Cloudflare dashboard. If the name is right, the bucket has simply had no activity this month and the probe will report zero usage.",
    1
  );
}

finish(
  "CLOUDFLARE_API_TOKEN reads R2 usage analytics for this account and bucket. The threshold monitor's R2 probe will succeed.",
  null,
  0
);
