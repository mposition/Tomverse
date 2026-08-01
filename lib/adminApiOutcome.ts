/**
 * How the admin console describes a failed `/api/admin/**` response.
 *
 * Until the console had a toast viewport, none of this reached anyone, so the
 * copy was never under pressure to be accurate. Two answers in particular were
 * being flattened into a plain error:
 *
 * - **409 with an `approvalId`** is not a failure. The request is queued and a
 *   second administrator has to approve that exact payload
 *   (`lib/adminApproval.ts`). Reporting it as "failed" tells the operator to
 *   retry, which queues a second request.
 * - **428** means the administrator's own sign-in is too old for a high-risk
 *   action. The fix is to sign in again, not to retry.
 *
 * Kept separate from any component so the mapping can be tested directly, and
 * so every panel says the same thing about the same response.
 */

export type AdminApiTone = "success" | "error" | "info";

export type AdminApiFailure = {
  message: string;
  tone: AdminApiTone;
  /** True when the operator has to sign in again before retrying. */
  requiresReauthentication: boolean;
  /** Set when the action is queued for a second administrator. */
  approvalId: string | null;
};

export const ADMIN_REAUTHENTICATION_MESSAGE =
  "Your administrator sign-in is no longer recent enough for this control. Sign in again, then retry the action.";

export const ADMIN_NETWORK_FAILURE_MESSAGE =
  "The request failed before the server answered. Check the connection and retry.";

export const adminApprovalPendingMessage = (approvalId: string) =>
  `Queued for a second administrator. Nothing has changed yet -- approval ${approvalId} has to be approved, then the same request re-sent.`;

export const describeAdminApiFailure = ({
  status,
  error,
  code,
  approvalId,
  fallback,
}: {
  status: number;
  error?: string | null;
  code?: string | null;
  approvalId?: string | null;
  /** What to say when the body carried no usable message. */
  fallback: string;
}): AdminApiFailure => {
  if (status === 428 || code === "ADMIN_REAUTHENTICATION_REQUIRED") {
    return {
      message: ADMIN_REAUTHENTICATION_MESSAGE,
      tone: "error",
      requiresReauthentication: true,
      approvalId: null,
    };
  }

  const trimmed = (error || "").trim();

  if (approvalId) {
    return {
      message: adminApprovalPendingMessage(approvalId),
      // Not an error: the request did exactly what the policy requires.
      tone: "info",
      requiresReauthentication: false,
      approvalId,
    };
  }

  return {
    message: trimmed || `${fallback} The server answered ${status}.`,
    tone: "error",
    requiresReauthentication: false,
    approvalId: null,
  };
};
