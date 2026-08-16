import assert from "node:assert/strict";
import test from "node:test";

import {
  CLOUDFLARE_ACCOUNT_SCOPE_QUERY,
  R2_ANALYTICS_QUERY,
  classifyCloudflareGraphqlFailure,
  cloudflareGraphqlErrorMessages,
  isCloudflareGraphqlEnvelope,
  isCloudflareRestEnvelope,
  r2AnalyticsVariables,
} from "../lib/cloudflareR2Analytics.ts";

// The incident behind this file: INFRASTRUCTURE_R2_ERROR paged production as
// fatal every thirty minutes for three days carrying Cloudflare's whole
// explanation -- "not authorized for that account" -- and that sentence has
// four unrelated causes. The classifier exists so a check can name one; these
// tests exist so it never names the wrong one.

test("a blocked host is not a rejected token", () => {
  // Verbatim shape from an egress proxy: an HTTP error with a plain-text body
  // and no Cloudflare envelope at all. Classifying this as a credential
  // failure sends the operator to rotate a token that was never tried.
  assert.equal(isCloudflareRestEnvelope(null), false);
  assert.equal(isCloudflareRestEnvelope("Host not in allowlist."), false);
  assert.equal(isCloudflareGraphqlEnvelope({ message: "Forbidden" }), false);
  assert.equal(
    classifyCloudflareGraphqlFailure({ message: "Forbidden" }, false),
    "intercepted"
  );
});

test("Cloudflare's own failures are recognised as its own", () => {
  assert.equal(isCloudflareRestEnvelope({ success: false, errors: [] }), true);
  assert.equal(isCloudflareGraphqlEnvelope({ data: null, errors: [] }), true);
  // A GraphQL response carrying data and no errors is still an envelope.
  assert.equal(isCloudflareGraphqlEnvelope({ data: { viewer: {} } }), true);
});

test("the production sentence classifies as an account authorization failure", () => {
  assert.equal(
    classifyCloudflareGraphqlFailure(
      { data: null, errors: [{ message: "not authorized for that account" }] },
      true
    ),
    "account_not_authorized"
  );
});

test("a rejected token is kept apart from an unauthorized account", () => {
  for (const message of [
    "Authentication error",
    "Invalid API Token",
    "Invalid request headers",
  ]) {
    assert.equal(
      classifyCloudflareGraphqlFailure({ errors: [{ message }] }, true),
      "token_rejected",
      message
    );
  }
});

test("a schema error is a query problem, never a permission answer", () => {
  assert.equal(
    classifyCloudflareGraphqlFailure(
      {
        errors: [
          { message: 'Unknown argument "bucketName" on field "storage".' },
        ],
      },
      true
    ),
    "query_rejected"
  );
  // A non-200 with no message to read is undetermined, not authorized.
  assert.equal(classifyCloudflareGraphqlFailure({ data: null }, false), "query_rejected");
});

test("a clean response is not a failure", () => {
  assert.equal(
    classifyCloudflareGraphqlFailure({ data: { viewer: { accounts: [] } } }, true),
    null
  );
  assert.deepEqual(cloudflareGraphqlErrorMessages({ data: {} }), []);
  // Malformed entries are dropped rather than turned into empty messages that
  // would read as an unexplained failure.
  assert.deepEqual(
    cloudflareGraphqlErrorMessages({ errors: [{ message: "a" }, {}, null] }),
    ["a"]
  );
});

test("both queries name the datasets the dashboard reads", () => {
  assert.match(R2_ANALYTICS_QUERY, /r2StorageAdaptiveGroups/);
  assert.match(R2_ANALYTICS_QUERY, /r2OperationsAdaptiveGroups/);
  // Cloudflare's analytics schema declares lowercase scalars; `String!` is a
  // validation error, which the classifier would report as `query_rejected`.
  assert.match(R2_ANALYTICS_QUERY, /\$accountTag: string!/);
  assert.match(CLOUDFLARE_ACCOUNT_SCOPE_QUERY, /\$accountTag: string!/);
  // The scope query must not name an R2 dataset: its whole purpose is to ask
  // about the account without the R2 permission confounding the answer.
  assert.doesNotMatch(CLOUDFLARE_ACCOUNT_SCOPE_QUERY, /r2[A-Z]/);
});

test("the window is month-to-date in UTC", () => {
  const variables = r2AnalyticsVariables(
    "account_1",
    "bucket_1",
    new Date("2026-08-16T19:15:39.750Z")
  );
  assert.deepEqual(variables, {
    accountTag: "account_1",
    startDate: "2026-08-01T00:00:00.000Z",
    endDate: "2026-08-16T19:15:39.750Z",
    bucketName: "bucket_1",
  });
});
