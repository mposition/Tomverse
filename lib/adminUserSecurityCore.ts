/**
 * The client-side rules for `POST /api/admin/users/:id/security`.
 *
 * These live outside the React component so the request body, the field
 * validation and the response copy can be tested without a browser, and so
 * there is exactly one place that decides which actions carry an expiry.
 *
 * Nothing here relaxes the server. `app/api/admin/users/[userId]/security`
 * keeps its own strict zod schema, its own expiry rule, its own support-ticket
 * requirement and its own two-person approval gate; this module only stops the
 * console from sending requests the server is right to reject.
 */

export type AdminSecurityAction =
  | "suspend"
  | "unsuspend"
  | "revoke_sessions"
  | "restrict_ai"
  | "unrestrict_ai"
  | "unlink_oauth"
  | "restore_account";

export const ADMIN_SECURITY_REASON_MIN_LENGTH = 5;
export const ADMIN_SECURITY_TICKET_MIN_LENGTH = 3;

/**
 * The only two actions that install a control which can later lift itself.
 * Mirrors `SECURITY_ACTIONS_WITH_EXPIRY` in the route handler -- the server
 * answers 400 (`The "<action>" action does not accept an expiry.`) for every
 * other action, including `restore_account`.
 */
export const ADMIN_SECURITY_ACTIONS_WITH_EXPIRY = [
  "suspend",
  "restrict_ai",
] as const satisfies readonly AdminSecurityAction[];

const EXPIRY_ACTIONS = new Set<AdminSecurityAction>(
  ADMIN_SECURITY_ACTIONS_WITH_EXPIRY
);

export const adminSecurityActionAcceptsExpiry = (action: AdminSecurityAction) =>
  EXPIRY_ACTIONS.has(action);

/**
 * Cancelling a scheduled deletion is the one action that has to be traceable
 * back to a customer conversation. It is deliberately *not* a two-person
 * approval action, so the ticket reference is the whole paper trail.
 */
export const adminSecurityActionRequiresSupportTicket = (
  action: AdminSecurityAction
) => action === "restore_account";

export type AdminSecurityField = "reason" | "supportTicketReference" | "until";

export type AdminSecurityFieldErrors = Partial<
  Record<AdminSecurityField, string>
>;

export type AdminSecurityActionInput = {
  action: AdminSecurityAction;
  reason: string;
  /** Raw `datetime-local` value, i.e. wall-clock time in the browser's zone. */
  until?: string | null;
  incidentNote?: string | null;
  provider?: string | null;
  supportTicketReference?: string | null;
};

export type AdminSecurityActionPayload = {
  action: AdminSecurityAction;
  reason: string;
  until: string | null;
  incidentNote: string | null;
  provider: string | null;
  supportTicketReference: string | null;
};

export type AdminSecurityExpiry =
  | { state: "empty" }
  | { state: "invalid" }
  | { state: "parsed"; at: Date };

/**
 * `datetime-local` has no zone, so `new Date("2026-08-01T09:30")` is read as
 * the administrator's own wall clock -- which is what the field label promises.
 */
export const parseAdminSecurityExpiry = (
  value: string | null | undefined
): AdminSecurityExpiry => {
  const trimmed = (value || "").trim();
  if (!trimmed) return { state: "empty" };
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return { state: "invalid" };
  return { state: "parsed", at: parsed };
};

export const validateAdminSecurityAction = (
  input: AdminSecurityActionInput,
  now: Date = new Date()
): AdminSecurityFieldErrors => {
  const errors: AdminSecurityFieldErrors = {};

  if ((input.reason || "").trim().length < ADMIN_SECURITY_REASON_MIN_LENGTH) {
    errors.reason = `Enter an audit reason of at least ${ADMIN_SECURITY_REASON_MIN_LENGTH} characters.`;
  }

  if (
    adminSecurityActionRequiresSupportTicket(input.action) &&
    (input.supportTicketReference || "").trim().length <
      ADMIN_SECURITY_TICKET_MIN_LENGTH
  ) {
    errors.supportTicketReference = `Enter the support ticket reference (at least ${ADMIN_SECURITY_TICKET_MIN_LENGTH} characters) that authorises this restoration.`;
  }

  // An expiry left behind in the form is not an error for an action that does
  // not take one -- buildAdminSecurityActionPayload simply drops it.
  if (adminSecurityActionAcceptsExpiry(input.action)) {
    const expiry = parseAdminSecurityExpiry(input.until);
    if (expiry.state === "invalid") {
      errors.until = "Enter a valid expiry date and time, or leave it empty.";
    } else if (
      expiry.state === "parsed" &&
      expiry.at.getTime() <= now.getTime()
    ) {
      errors.until = "The control expiry must be in the future.";
    }
  }

  return errors;
};

export const hasAdminSecurityFieldErrors = (errors: AdminSecurityFieldErrors) =>
  Object.values(errors).some(Boolean);

/**
 * Builds the exact request body, per action.
 *
 * The console keeps one shared expiry field, so a value chosen for an earlier
 * suspension is still in component state when the administrator later clicks
 * "Cancel deletion & restore account". Forwarding it produced a 400 the
 * operator never saw. `until` is therefore derived from the action, never from
 * whatever the field happens to hold.
 */
export const buildAdminSecurityActionPayload = (
  input: AdminSecurityActionInput
): AdminSecurityActionPayload => {
  const expiry = adminSecurityActionAcceptsExpiry(input.action)
    ? parseAdminSecurityExpiry(input.until)
    : ({ state: "empty" } as const);

  return {
    action: input.action,
    reason: (input.reason || "").trim(),
    until: expiry.state === "parsed" ? expiry.at.toISOString() : null,
    incidentNote: (input.incidentNote || "").trim() || null,
    provider: (input.provider || "").trim() || null,
    supportTicketReference: adminSecurityActionRequiresSupportTicket(
      input.action
    )
      ? (input.supportTicketReference || "").trim() || null
      : null,
  };
};

const PENDING_LABELS: Record<AdminSecurityAction, string> = {
  suspend: "Suspending...",
  unsuspend: "Lifting suspension...",
  revoke_sessions: "Revoking sessions...",
  restrict_ai: "Restricting AI usage...",
  unrestrict_ai: "Restoring AI usage...",
  unlink_oauth: "Unlinking...",
  restore_account: "Restoring...",
};

export const adminSecurityActionPendingLabel = (action: AdminSecurityAction) =>
  PENDING_LABELS[action];

const SUCCESS_MESSAGES: Record<AdminSecurityAction, string> = {
  suspend: "Account suspended and every session revoked.",
  unsuspend: "Account suspension lifted.",
  revoke_sessions: "All sessions revoked.",
  restrict_ai: "AI usage restricted.",
  unrestrict_ai: "AI usage restriction lifted.",
  unlink_oauth: "Linked login removed and sessions revoked.",
  restore_account:
    "Scheduled deletion cancelled and the account restored. Automatic subscription renewal stays off.",
};

/**
 * `restore_account` on an account that is already active is a no-op server
 * side, and saying so is the difference between "we fixed it" and "there was
 * nothing to fix" -- which matters when a support agent is deciding whether to
 * keep escalating.
 */
export const adminSecurityActionSuccessMessage = (
  action: AdminSecurityAction,
  options: { alreadyRestored?: boolean } = {}
) =>
  options.alreadyRestored
    ? "This account was already active, so no change was made."
    : SUCCESS_MESSAGES[action];

export type AdminSecurityFailure = {
  message: string;
  /** True when the administrator has to sign in again before retrying. */
  requiresReauthentication: boolean;
};

export const ADMIN_SECURITY_REAUTHENTICATION_MESSAGE =
  "Your administrator sign-in is no longer recent enough for this control. Sign in again, then retry the action.";

/**
 * Turns any failed response into something the console can show.
 *
 * The route answers with a JSON `error` for 400/403/404/409 and 500, adds
 * `approvalId` when a second administrator has to approve, and 428 with
 * `code: "ADMIN_REAUTHENTICATION_REQUIRED"` when the step-up window has
 * expired. A body that could not be parsed at all still has to produce a
 * message, so the status carries it.
 */
export const describeAdminSecurityFailure = ({
  status,
  error,
  code,
  approvalId,
}: {
  status: number;
  error?: string | null;
  code?: string | null;
  approvalId?: string | null;
}): AdminSecurityFailure => {
  if (status === 428 || code === "ADMIN_REAUTHENTICATION_REQUIRED") {
    return {
      message: ADMIN_SECURITY_REAUTHENTICATION_MESSAGE,
      requiresReauthentication: true,
    };
  }

  const trimmed = (error || "").trim();
  if (approvalId) {
    return {
      message: `${trimmed || "A second administrator must approve this action."} Approval ${approvalId}`,
      requiresReauthentication: false,
    };
  }

  return {
    message:
      trimmed || `Security control failed. The server answered ${status}.`,
    requiresReauthentication: false,
  };
};

export const ADMIN_SECURITY_NETWORK_FAILURE_MESSAGE =
  "Security control failed before the server answered. Check the connection and retry.";
