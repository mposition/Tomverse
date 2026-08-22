import type { ProviderSendResult } from "@/lib/emailProviderPortCore";

/**
 * What a test send through an operator-alert path reports back.
 *
 * Contract: docs/policy/email-notifications.md §14.1.
 * Background: docs/ops/email-sending-domains.md §1.2, §3.5.2.
 *
 * ## Why this exists
 *
 * The two operator-alert paths only run when something is genuinely wrong: the
 * operational one inside `reportOperationalIncident`, the provider one when a
 * budget or a balance runs out. Neither has ever had a way to be exercised on
 * purpose, and that is not a small gap -- it is the reason nobody could tell
 * that three of four senders had stayed on the old domain when the
 * transactional domain moved. A path nothing routinely runs is a path whose
 * breakage is discovered by the outage it was supposed to report.
 *
 * ## What a passing probe does and does not establish
 *
 * It establishes that **this path's own send function** resolves a recipient,
 * resolves a sending identity, reaches the provider, and is accepted -- with
 * the deployment's real key, from the address it will really use.
 *
 * It establishes nothing about the detection above it. A probe cannot tell you
 * that a provider budget running out will call this path; only that if
 * something calls it, a message goes out. The screen says so, because a
 * control that quietly implies more than it checked is worse than no control.
 */

export type OperatorAlertPath = "operational" | "provider";

export const OPERATOR_ALERT_PATHS = ["operational", "provider"] as const;

export type OperatorAlertProbeResult = {
  path: OperatorAlertPath;
  delivered: boolean;
  /** The address the provider accepted, or null when nothing was sent. */
  from: string | null;
  providerMessageId: string | null;
  /** Where it went. Null when the path has no recipient configured. */
  recipient: string | null;
  /**
   * Why nothing was sent, in the path's own terms. Null on success.
   *
   * Deliberately a code plus a sentence rather than a raw provider body: the
   * body can name a recipient, and this string is rendered to a screen and
   * written to an audit entry.
   */
  failure: { code: string; message: string } | null;
};

/**
 * One provider answer, read into the shape both paths report.
 *
 * Shared so the two paths cannot describe the same outcome differently. They
 * already drifted once on something smaller than this -- the From address --
 * and the fix was to stop having two of it.
 */
export const operatorAlertProbeResult = (input: {
  path: OperatorAlertPath;
  recipient: string | null;
  send: ProviderSendResult | null;
}): OperatorAlertProbeResult => {
  const base = {
    path: input.path,
    recipient: input.recipient,
    from: null,
    providerMessageId: null,
  };

  if (!input.recipient) {
    return {
      ...base,
      delivered: false,
      failure: {
        code: "RECIPIENT_NOT_CONFIGURED",
        message:
          input.path === "operational"
            ? "Neither OPS_ALERT_EMAIL nor ADMIN_ALERT_EMAIL is set, so this path sends nothing and says nothing about it."
            : "ADMIN_ALERT_EMAIL is not set, so this path sends nothing.",
      },
    };
  }

  // Null send means the path returned before reaching the provider for a reason
  // the caller already described. Treated as a failure rather than silence.
  if (!input.send) {
    return {
      ...base,
      delivered: false,
      failure: {
        code: "NOT_ATTEMPTED",
        message: "The path returned before reaching the provider.",
      },
    };
  }

  if (input.send.ok) {
    return {
      ...base,
      delivered: true,
      from: input.send.from,
      providerMessageId: input.send.providerMessageId,
      failure: null,
    };
  }

  if (input.send.notConfigured) {
    return {
      ...base,
      delivered: false,
      failure: {
        code: "PROVIDER_KEY_MISSING",
        message:
          "No provider API key for the transactional stream, so nothing was sent and nothing was rejected.",
      },
    };
  }

  if (input.send.identityRefusal) {
    return {
      ...base,
      delivered: false,
      failure: {
        code: input.send.identityRefusal,
        message:
          "The sending identity for this stream could not be resolved, so the message was refused before the wire.",
      },
    };
  }

  return {
    ...base,
    delivered: false,
    failure:
      input.send.status === null
        ? {
            code: "NO_RESPONSE",
            message: "The provider was not reached at all.",
          }
        : {
            code: `HTTP_${input.send.status}`,
            message: `The provider refused the message with ${input.send.status}.`,
          },
  };
};
