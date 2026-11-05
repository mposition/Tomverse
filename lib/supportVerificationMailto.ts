/**
 * The address link the support form offers when its security check cannot be
 * made to work.
 *
 * Email is the one support channel that never needed a check, but a bare
 * `mailto:` address asks the visitor to write the request a second time. This
 * builds the link out of what the form already holds -- the request type as
 * the subject, the words already typed as the body -- so the enquiry continues
 * instead of restarting.
 *
 * Only what the visitor typed travels: no diagnostics, no trace of the check,
 * no address of their own (their mail client supplies the sender).
 *
 * Pure and dependency-free on purpose: the support page builds its href with
 * it and tests/supportVerificationRecovery.test.mjs exercises it directly.
 */

/**
 * How much of the typed message the link may carry.
 *
 * A `mailto:` href is handed to the operating system's mail handler, and long
 * ones are cut by some of them without saying so. The cut is made here, where
 * it can be marked, and it costs nothing: the form keeps the full text, so a
 * later retry still submits all of it.
 */
export const SUPPORT_MAILTO_BODY_MAX_LENGTH = 1_500;

/** Marks a body this link could not carry whole. */
const TRUNCATION_MARKER = "\n[truncated]";

export const buildSupportVerificationMailto = ({
  address,
  subject,
  message,
}: {
  address: string;
  subject?: string;
  message?: string;
}) => {
  const params: string[] = [];
  const trimmedSubject = subject?.trim();
  if (trimmedSubject) {
    params.push(`subject=${encodeURIComponent(trimmedSubject)}`);
  }
  const trimmedMessage = message?.trim();
  if (trimmedMessage) {
    const body =
      trimmedMessage.length > SUPPORT_MAILTO_BODY_MAX_LENGTH
        ? `${trimmedMessage.slice(0, SUPPORT_MAILTO_BODY_MAX_LENGTH)}${TRUNCATION_MARKER}`
        : trimmedMessage;
    params.push(`body=${encodeURIComponent(body)}`);
  }
  return params.length
    ? `mailto:${address}?${params.join("&")}`
    : `mailto:${address}`;
};
