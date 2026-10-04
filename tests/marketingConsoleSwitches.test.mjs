import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalMarketingWebhookFileText,
  marketingWebhookApplyScopeSchema,
  marketingWebhookApplyScopeStatus,
} from "../lib/marketingAutomationAccess.ts";

/**
 * The Admin console's apply-scope row and the access decision must agree.
 *
 * They disagreed twice, in opposite directions, because the screen judged the
 * stored string itself: an empty string read as "nothing stored" where the
 * decision refuses a stored document, and a BOM-prefixed scope read as
 * malformed where the decision strips the BOM and accepts it. A reviewer found
 * both by running the two paths side by side rather than by reading them.
 *
 * The screen no longer has a judgement of its own --
 * `marketingWebhookApplyScopeStatus()` lives beside the decision and is what
 * both use. What is pinned here is that this function keeps the two properties
 * the divergence came from: it canonicalises before parsing, and it accepts
 * only what the scope schema accepts.
 */

const SCOPE = {
  recordId: "2026-09-22__linkedin-1",
  scope: [{ eventType: "post.published", channelId: "linkedin-1" }],
};

const valid = JSON.stringify(SCOPE);

test("the scope fixture is one the real schema accepts", () => {
  // Otherwise every "valid" case below would be asserting the wrong thing.
  assert.equal(marketingWebhookApplyScopeSchema.safeParse(SCOPE).success, true);
});

test("a missing value is absent, which is not the same as invalid", () => {
  // The one state the decision does not distinguish: it refuses a missing
  // value and a malformed one alike. The screen distinguishes them because
  // only one of the two is somebody's mistake sitting in a row.
  assert.equal(marketingWebhookApplyScopeStatus(null), "absent");
  assert.equal(marketingWebhookApplyScopeStatus(undefined), "absent");
});

test("an empty string is a stored document, and it is invalid", () => {
  // The first divergence. `""` is a row someone wrote; reading it as "no
  // scope" told an operator nothing was configured when something was.
  assert.equal(marketingWebhookApplyScopeStatus(""), "invalid");
});

test("a stored string that is not JSON is invalid", () => {
  assert.equal(marketingWebhookApplyScopeStatus("not json"), "invalid");
});

test("JSON that the scope schema refuses is invalid", () => {
  assert.equal(marketingWebhookApplyScopeStatus("{}"), "invalid");
  assert.equal(
    marketingWebhookApplyScopeStatus(
      JSON.stringify({ recordId: "not-a-record-id", scope: SCOPE.scope })
    ),
    "invalid"
  );
  assert.equal(
    marketingWebhookApplyScopeStatus(JSON.stringify({ ...SCOPE, extra: 1 })),
    "invalid"
  );
});

test("a valid scope is valid", () => {
  assert.equal(marketingWebhookApplyScopeStatus(valid), "valid");
});

test("a BOM does not make a valid scope invalid", () => {
  // The second divergence, in the other direction. The decision canonicalises
  // the BOM away, so a screen that did not would report a working scope as
  // broken.
  const withBom = `﻿${valid}`;
  assert.equal(canonicalMarketingWebhookFileText(withBom), valid);
  assert.equal(marketingWebhookApplyScopeStatus(withBom), "valid");
});

test("CRLF line endings do not make a valid scope invalid", () => {
  const withCrlf = JSON.stringify(SCOPE, null, 2).replaceAll("\n", "\r\n");
  assert.equal(marketingWebhookApplyScopeStatus(withCrlf), "valid");
});
