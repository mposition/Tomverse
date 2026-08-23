import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  ADMIN_NETWORK_FAILURE_MESSAGE,
  ADMIN_REAUTHENTICATION_MESSAGE,
  adminApprovalPendingMessage,
  describeAdminApiFailure,
} from "../lib/adminApiOutcome.ts";
import { describeRefundApproval } from "../lib/adminRefundOutcomeCopy.ts";

// ---------------------------------------------------------------------------
// Failed admin responses
// ---------------------------------------------------------------------------

const failure = (overrides = {}) =>
  describeAdminApiFailure({
    status: 500,
    fallback: "The action did not complete.",
    ...overrides,
  });

test("a body's own error text is what the operator is shown", () => {
  const described = failure({
    status: 400,
    error: 'The "restore_account" action does not accept an expiry.',
  });
  assert.equal(
    described.message,
    'The "restore_account" action does not accept an expiry.'
  );
  assert.equal(described.tone, "error");
  assert.equal(described.approvalId, null);
  assert.equal(described.requiresReauthentication, false);
});

// The whole point of the shared helper: an approval-pending 409 is the
// two-person policy working. Calling it a failure tells the operator to retry,
// and a retry queues a second request instead of completing the first.
test("an approval-pending 409 is reported as pending, not as a failure", () => {
  const described = failure({
    status: 409,
    error: "A second administrator must approve this action.",
    approvalId: "apr_123",
  });
  assert.equal(described.tone, "info");
  assert.equal(described.approvalId, "apr_123");
  assert.match(described.message, /apr_123/);
  assert.match(described.message, /Nothing has changed yet/i);
  assert.equal(described.message, adminApprovalPendingMessage("apr_123"));
  assert.equal(described.requiresReauthentication, false);
});

test("a 428 asks for a fresh sign-in and outranks any approval id", () => {
  for (const input of [
    { status: 428 },
    { status: 428, approvalId: "apr_123" },
    { status: 500, code: "ADMIN_REAUTHENTICATION_REQUIRED" },
  ]) {
    const described = failure(input);
    assert.equal(described.requiresReauthentication, true, JSON.stringify(input));
    assert.equal(described.message, ADMIN_REAUTHENTICATION_MESSAGE);
    assert.equal(described.tone, "error");
    assert.equal(described.approvalId, null);
  }
});

// A 500 from a route handler, or an HTML proxy page, leaves nothing parseable.
// Silence is what the missing toast viewport looked like, so there is always a
// message and it names the status.
test("an unparseable body still produces the caller's own fallback", () => {
  const described = failure({ status: 502 });
  assert.match(described.message, /The action did not complete\./);
  assert.match(described.message, /502/);

  const blank = failure({ status: 503, error: "   " });
  assert.match(blank.message, /503/);
});

test("the network-failure message never mentions an internal error", () => {
  assert.doesNotMatch(ADMIN_NETWORK_FAILURE_MESSAGE, /undefined|\[object|TypeError/);
  assert.match(ADMIN_NETWORK_FAILURE_MESSAGE, /retry/i);
});

// ---------------------------------------------------------------------------
// Refund approval outcomes
// ---------------------------------------------------------------------------

// The console said "Refund request approved. The user was moved to Free." for
// every one of these. Four of the six move no money at all.
test("a completed Stripe refund is the only outcome reported as a plain success", () => {
  const described = describeRefundApproval({
    stripeRefundStatus: "succeeded",
    stripeRefundId: "re_123",
    refundAmountCents: 2_000,
    refundCurrency: "USD",
  });
  assert.equal(described.tone, "success");
  assert.equal(described.refunded, true);
  assert.match(described.message, /reset to Free/i);
  assert.match(described.message, /Stripe refunded/i);
  assert.match(described.message, /\$20/);
});

test("a still-settling refund says so instead of claiming completion", () => {
  const described = describeRefundApproval({
    stripeRefundStatus: "pending",
    stripeRefundId: "re_123",
    refundAmountCents: 2_000,
    refundCurrency: "USD",
  });
  assert.equal(described.tone, "info");
  assert.equal(described.refunded, true);
  assert.match(described.message, /pending/i);
  assert.match(described.message, /confirm it settles/i);
});

test("every outcome where no money moved is distinguishable and not a plain success", () => {
  const cases = [
    { status: "no_payment_intent", expect: /no Stripe payment was found/i },
    { status: "no_charge", expect: /no charge to refund/i },
    { status: "already_refunded", expect: /already refunded/i },
    { status: null, expect: /no Stripe subscription, or Stripe is not configured/i },
  ];
  const messages = new Set();
  for (const testCase of cases) {
    const described = describeRefundApproval({
      stripeRefundStatus: testCase.status,
    });
    assert.equal(
      described.tone,
      "info",
      `${testCase.status} must not read as a completed refund`
    );
    assert.equal(described.refunded, false);
    assert.match(described.message, testCase.expect);
    // The approval and the downgrade did happen, and must still be stated.
    assert.match(described.message, /approved/i);
    assert.match(described.message, /reset to Free/i);
    messages.add(described.message);
  }
  assert.equal(messages.size, cases.length, "each outcome needs its own wording");
});

test("an unrecognised Stripe status is quoted rather than guessed at", () => {
  const described = describeRefundApproval({
    stripeRefundStatus: "requires_action",
  });
  assert.equal(described.tone, "info");
  assert.equal(described.refunded, false);
  assert.match(described.message, /"requires_action"/);
  assert.match(described.message, /check the charge/i);
});

test("no refund outcome claims money moved unless Stripe says it did", () => {
  for (const status of [
    "no_payment_intent",
    "no_charge",
    "already_refunded",
    null,
    "requires_action",
  ]) {
    const { message } = describeRefundApproval({ stripeRefundStatus: status });
    assert.doesNotMatch(
      message,
      /Stripe refunded/i,
      `${status} must not claim Stripe refunded anything`
    );
  }
});

/* ------------------------------------ naming the remedy is not offering it -- */

/**
 * A 428 tells the operator their own sign-in is too old. Classifying it was
 * already done here; what was missing is anywhere to go.
 *
 * Observed on 2026-08-23 in the retention panel: the notice appeared, named
 * the remedy, and then the toast disappeared with no way to reach a sign-in.
 * `AdminUserSecurityControls` already had the affordance, so this is adoption
 * rather than a second implementation.
 */

test("the retention panel offers the sign-in its 428 notice asks for", () => {
    const panel = readFileSync("components/admin/AdminRetentionPanel.tsx", "utf8");
    // Classified rather than relayed: the raw server sentence names the
    // remedy without the shared copy's context, and carries no flag to act on.
    assert.match(panel, /describeAdminApiFailure\(/);
    assert.match(panel, /failure\?\.requiresReauthentication/);
    // The step-up URL, the same helper the security controls use.
    assert.match(panel, /adminRecentAuthenticationHref\(pathname\)/);
    assert.match(panel, /data-testid="admin-retention-reauthenticate-link"/);
    // Cleared on success, so it cannot outlive the attempt it explains.
    assert.match(panel, /setFailure\(null\);/);
});

test("the settings write is audited under a name that covers what it writes", () => {
    const route = readFileSync("app/api/admin/app-settings/route.ts", "utf8");
    // One handler writes eight settings in one transaction. Naming the
    // completion after one of them misled an auditor twice on 2026-08-23:
    // past the feature-flag change they were looking for, and into reading a
    // guest-default change that had not happened.
    assert.match(route, /action: "app_settings\.update_started"/);
    assert.match(route, /action: "app_settings\.update_completed"/);
    assert.doesNotMatch(route, /action: "app_settings\.guest_default_model\.updated"/);
});
