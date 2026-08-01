import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_SECURITY_ACTIONS_WITH_EXPIRY,
  ADMIN_SECURITY_REASON_MIN_LENGTH,
  ADMIN_SECURITY_REAUTHENTICATION_MESSAGE,
  ADMIN_SECURITY_TICKET_MIN_LENGTH,
  adminSecurityActionAcceptsExpiry,
  adminSecurityActionPendingLabel,
  adminSecurityActionRequiresSupportTicket,
  adminSecurityActionSuccessMessage,
  buildAdminSecurityActionPayload,
  describeAdminSecurityFailure,
  hasAdminSecurityFieldErrors,
  parseAdminSecurityExpiry,
  validateAdminSecurityAction,
} from "../lib/adminUserSecurityCore.ts";

const ALL_ACTIONS = [
  "suspend",
  "unsuspend",
  "revoke_sessions",
  "restrict_ai",
  "unrestrict_ai",
  "unlink_oauth",
  "restore_account",
];

const EXPIRY_FREE_ACTIONS = ALL_ACTIONS.filter(
  (action) => !ADMIN_SECURITY_ACTIONS_WITH_EXPIRY.includes(action)
);

const baseInput = (overrides = {}) => ({
  action: "suspend",
  reason: "Confirmed account takeover reported by the customer",
  until: "",
  incidentNote: "",
  provider: null,
  supportTicketReference: "",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Payload construction: which actions may carry `until`
// ---------------------------------------------------------------------------

// The defect. The console keeps one shared expiry field, so a date chosen for
// an earlier suspension is still in state when the operator later clicks
// "Cancel deletion & restore account". Forwarding it made the server answer
// 400 -- `The "restore_account" action does not accept an expiry.` -- and the
// console had no viewport to show that answer, so restoration just silently
// did nothing.
test("restore_account never forwards a leftover expiry", () => {
  const payload = buildAdminSecurityActionPayload(
    baseInput({
      action: "restore_account",
      reason: "Customer withdrew the deletion request",
      until: "2099-01-01T09:00",
      supportTicketReference: "SUP-4821",
    })
  );

  assert.equal(payload.until, null);
  assert.equal(payload.action, "restore_account");
  assert.equal(payload.supportTicketReference, "SUP-4821");
});

test("every action that the server rejects an expiry for sends until: null", () => {
  for (const action of EXPIRY_FREE_ACTIONS) {
    const payload = buildAdminSecurityActionPayload(
      baseInput({
        action,
        until: "2099-01-01T09:00",
        supportTicketReference: "SUP-4821",
      })
    );
    assert.equal(
      payload.until,
      null,
      `${action} must not carry an expiry the server would reject`
    );
    // `null` and "absent" are different bodies. The key has to be present so
    // an earlier value can never be inherited by a later request.
    assert.ok(
      Object.prototype.hasOwnProperty.call(payload, "until"),
      `${action} must send an explicit until key`
    );
  }
});

test("suspend and restrict_ai send the chosen expiry as an ISO instant", () => {
  for (const action of ADMIN_SECURITY_ACTIONS_WITH_EXPIRY) {
    const payload = buildAdminSecurityActionPayload(
      baseInput({ action, until: "2099-03-04T05:06" })
    );
    // `datetime-local` has no zone, so the value is the administrator's own
    // wall clock -- exactly what the field's helper text promises.
    assert.equal(payload.until, new Date("2099-03-04T05:06").toISOString());
    assert.match(payload.until, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  }
});

test("an empty expiry stays null even for the actions that accept one", () => {
  for (const action of ADMIN_SECURITY_ACTIONS_WITH_EXPIRY) {
    assert.equal(
      buildAdminSecurityActionPayload(baseInput({ action, until: "" })).until,
      null
    );
    assert.equal(
      buildAdminSecurityActionPayload(baseInput({ action, until: null })).until,
      null
    );
  }
});

test("the support ticket reference is only sent for restore_account", () => {
  for (const action of ALL_ACTIONS) {
    const payload = buildAdminSecurityActionPayload(
      baseInput({ action, supportTicketReference: "  SUP-9001  " })
    );
    assert.equal(
      payload.supportTicketReference,
      action === "restore_account" ? "SUP-9001" : null,
      `${action} carried the wrong support ticket reference`
    );
  }
});

test("optional text fields collapse to null rather than empty strings", () => {
  const payload = buildAdminSecurityActionPayload(
    baseInput({ incidentNote: "   ", provider: "   " })
  );
  assert.equal(payload.incidentNote, null);
  assert.equal(payload.provider, null);
});

test("the provider is forwarded for an OAuth unlink", () => {
  const payload = buildAdminSecurityActionPayload(
    baseInput({ action: "unlink_oauth", provider: "google" })
  );
  assert.equal(payload.provider, "google");
  assert.equal(payload.until, null);
});

test("the reason is trimmed, matching the server's zod schema", () => {
  const payload = buildAdminSecurityActionPayload(
    baseInput({ reason: "  Verified support escalation  " })
  );
  assert.equal(payload.reason, "Verified support escalation");
});

test("the expiry policy agrees with the route handler's own list", () => {
  assert.deepEqual([...ADMIN_SECURITY_ACTIONS_WITH_EXPIRY], [
    "suspend",
    "restrict_ai",
  ]);
  for (const action of ALL_ACTIONS) {
    assert.equal(
      adminSecurityActionAcceptsExpiry(action),
      action === "suspend" || action === "restrict_ai"
    );
  }
});

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

test("an audit reason under the minimum is reported against the reason field", () => {
  const errors = validateAdminSecurityAction(baseInput({ reason: "bad" }));
  assert.ok(errors.reason);
  assert.match(errors.reason, /at least 5 characters/);
  assert.equal(errors.supportTicketReference, undefined);
  assert.equal(hasAdminSecurityFieldErrors(errors), true);
  assert.equal(ADMIN_SECURITY_REASON_MIN_LENGTH, 5);
});

test("whitespace does not satisfy the audit reason minimum", () => {
  const errors = validateAdminSecurityAction(baseInput({ reason: "      " }));
  assert.ok(errors.reason);
});

test("restore_account requires a support ticket reference of its own", () => {
  const errors = validateAdminSecurityAction(
    baseInput({
      action: "restore_account",
      reason: "Customer withdrew the deletion request",
      supportTicketReference: "SU",
    })
  );
  assert.ok(errors.supportTicketReference);
  assert.match(errors.supportTicketReference, /at least 3 characters/);
  assert.equal(errors.reason, undefined);
  assert.equal(ADMIN_SECURITY_TICKET_MIN_LENGTH, 3);
});

test("only restore_account demands a support ticket reference", () => {
  for (const action of ALL_ACTIONS) {
    const errors = validateAdminSecurityAction(
      baseInput({ action, supportTicketReference: "" })
    );
    assert.equal(
      Boolean(errors.supportTicketReference),
      action === "restore_account",
      `${action} disagreed with the support-ticket policy`
    );
    assert.equal(
      adminSecurityActionRequiresSupportTicket(action),
      action === "restore_account"
    );
  }
});

test("an expiry in the past is rejected before the request is sent", () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  const errors = validateAdminSecurityAction(
    baseInput({ action: "suspend", until: "2020-01-01T00:00" }),
    now
  );
  assert.ok(errors.until);
  assert.match(errors.until, /must be in the future/);
});

test("an unparseable expiry is reported against the expiry field", () => {
  const errors = validateAdminSecurityAction(
    baseInput({ action: "restrict_ai", until: "not-a-date" })
  );
  assert.ok(errors.until);
  assert.match(errors.until, /valid expiry/);
});

// A stale expiry is a payload concern, not an operator error: the action it was
// typed for simply is not the one being run, so it is dropped silently.
test("a leftover expiry is not an error for an action that ignores it", () => {
  for (const action of EXPIRY_FREE_ACTIONS) {
    const errors = validateAdminSecurityAction(
      baseInput({
        action,
        until: "2020-01-01T00:00",
        supportTicketReference: "SUP-4821",
      })
    );
    assert.equal(errors.until, undefined, `${action} flagged a dropped expiry`);
  }
});

test("a valid request produces no field errors", () => {
  const errors = validateAdminSecurityAction(
    baseInput({ action: "suspend", until: "2099-01-01T09:00" })
  );
  assert.deepEqual(errors, {});
  assert.equal(hasAdminSecurityFieldErrors(errors), false);
});

test("expiry parsing distinguishes empty from invalid", () => {
  assert.deepEqual(parseAdminSecurityExpiry(""), { state: "empty" });
  assert.deepEqual(parseAdminSecurityExpiry(null), { state: "empty" });
  assert.deepEqual(parseAdminSecurityExpiry("  "), { state: "empty" });
  assert.deepEqual(parseAdminSecurityExpiry("nope"), { state: "invalid" });
  assert.equal(parseAdminSecurityExpiry("2099-01-01T09:00").state, "parsed");
});

// ---------------------------------------------------------------------------
// Progress and result copy
// ---------------------------------------------------------------------------

test("every action has its own progress label", () => {
  const labels = ALL_ACTIONS.map((action) =>
    adminSecurityActionPendingLabel(action)
  );
  assert.equal(new Set(labels).size, labels.length);
  for (const label of labels) assert.match(label, /\.\.\.$/);
  assert.equal(adminSecurityActionPendingLabel("restore_account"), "Restoring...");
});

test("a no-op restoration is reported differently from a real one", () => {
  const restored = adminSecurityActionSuccessMessage("restore_account");
  const noop = adminSecurityActionSuccessMessage("restore_account", {
    alreadyRestored: true,
  });
  assert.notEqual(restored, noop);
  assert.match(noop, /already active/i);
  // Restoration must not promise something the server does not do: Stripe
  // automatic renewal stays off (lib/accountDeletion.restoreTomverseAccount).
  assert.match(restored, /renewal stays off/i);
});

test("every action has its own success message", () => {
  const messages = ALL_ACTIONS.map((action) =>
    adminSecurityActionSuccessMessage(action)
  );
  assert.equal(new Set(messages).size, messages.length);
});

// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------

test("a 400 body's error text is what the operator is shown", () => {
  const failure = describeAdminSecurityFailure({
    status: 400,
    error: 'The "restore_account" action does not accept an expiry.',
  });
  assert.equal(
    failure.message,
    'The "restore_account" action does not accept an expiry.'
  );
  assert.equal(failure.requiresReauthentication, false);
});

test("a 409 for an already-started deletion keeps the server's wording", () => {
  const failure = describeAdminSecurityFailure({
    status: 409,
    error:
      "This account's permanent deletion has already started and can no longer be cancelled.",
    code: "DELETION_ALREADY_PROCESSING",
  });
  assert.match(failure.message, /already started/);
  assert.equal(failure.requiresReauthentication, false);
});

test("a 428 asks for a fresh sign-in and flags the reauthentication route", () => {
  const byStatus = describeAdminSecurityFailure({
    status: 428,
    error: "Sign in again before performing this high-risk administrator action.",
    code: "ADMIN_REAUTHENTICATION_REQUIRED",
  });
  assert.equal(byStatus.requiresReauthentication, true);
  assert.equal(byStatus.message, ADMIN_SECURITY_REAUTHENTICATION_MESSAGE);
  assert.match(byStatus.message, /[Ss]ign in again/);

  // The code alone is enough, in case a proxy rewrites the status.
  const byCode = describeAdminSecurityFailure({
    status: 500,
    code: "ADMIN_REAUTHENTICATION_REQUIRED",
  });
  assert.equal(byCode.requiresReauthentication, true);
});

test("a pending two-person approval surfaces its approval id", () => {
  const failure = describeAdminSecurityFailure({
    status: 409,
    error: "A second administrator must approve this action.",
    approvalId: "apr_123",
  });
  assert.match(failure.message, /apr_123/);
  assert.equal(failure.requiresReauthentication, false);
});

// A 500 from the route handler, or a proxy page, can leave nothing parseable
// behind. Silence is what the bug looked like, so there is always a message.
test("an unparseable response body still yields a message", () => {
  const failure = describeAdminSecurityFailure({ status: 500 });
  assert.match(failure.message, /500/);
  assert.ok(failure.message.length > 0);

  const blank = describeAdminSecurityFailure({ status: 502, error: "   " });
  assert.match(blank.message, /502/);
});
