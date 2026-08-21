import "server-only";

import {
  parseFromAddress,
  sendingIdentityReadiness,
  streamForClassification,
  type SendingStream,
} from "@/lib/emailSendingIdentityCore";

/**
 * The From address each stream sends from.
 *
 * Contract: docs/policy/email-notifications.md §14.1, §5.3, §17.3.
 *
 * The decision rules are pure and live in lib/emailSendingIdentityCore.ts;
 * this reads the environment and refuses.
 */

/**
 * The historical default, kept exactly as it was.
 *
 * It is the registrable domain rather than a sending subdomain, which is the
 * state §17.3 step 1 moves away from -- and moving it is a DNS change plus a
 * one-off notice to users whose filters name the current address, not
 * something a deploy may do by changing a default. So the default stays wrong
 * on purpose and the health check says so, rather than a deploy silently
 * changing the From address every existing filter matches on.
 */
const TRANSACTIONAL_FALLBACK = "Tomverse Insight <hello@tomverse.app>";

export class SendingIdentityError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SendingIdentityError";
    this.code = code;
  }
}

const transactionalFromValue = () =>
  process.env.TRANSACTIONAL_EMAIL_FROM ||
  process.env.EMAIL_FROM ||
  TRANSACTIONAL_FALLBACK;

const marketingFromValue = () => process.env.MARKETING_EMAIL_FROM || null;

/**
 * The From header for a stream, or a refusal.
 *
 * Marketing refuses in two cases, and both are the same mistake seen from
 * different sides: no marketing address configured, or one that shares the
 * transactional domain. Falling back to the transactional address in either
 * case would send the promotion successfully and quietly move its spam
 * complaints onto the domain that carries login codes -- a failure with no
 * symptom until the login codes stop arriving (§5.3).
 *
 * Transactional never refuses on domain grounds: it has a working default, and
 * the subdomain migration is a warning rather than a gate.
 */
export const fromAddressForStream = (stream: SendingStream): string => {
  if (stream === "transactional") {
    const value = transactionalFromValue();
    if (!parseFromAddress(value)) {
      throw new SendingIdentityError(
        "TRANSACTIONAL_FROM_UNPARSEABLE",
        "TRANSACTIONAL_EMAIL_FROM is not a readable address."
      );
    }
    return value;
  }

  const marketing = marketingFromValue();
  if (!marketing) {
    throw new SendingIdentityError(
      "MARKETING_FROM_MISSING",
      "Marketing mail has no sending identity of its own (MARKETING_EMAIL_FROM). Sending it from the transactional domain is refused rather than defaulted."
    );
  }
  const parsedMarketing = parseFromAddress(marketing);
  if (!parsedMarketing) {
    throw new SendingIdentityError(
      "MARKETING_FROM_UNPARSEABLE",
      "MARKETING_EMAIL_FROM is not a readable address."
    );
  }
  const parsedTransactional = parseFromAddress(transactionalFromValue());
  if (parsedTransactional && parsedTransactional.domain === parsedMarketing.domain) {
    throw new SendingIdentityError(
      "STREAMS_SHARE_A_DOMAIN",
      `Marketing and transactional mail would both send from ${parsedMarketing.domain}. Domain reputation is the one layer that separates the two streams (§5.3).`
    );
  }
  return marketing;
};

/** The From header for a template classification. */
export const fromAddressForClassification = (classification: string) =>
  fromAddressForStream(streamForClassification(classification));

/** What a health check or an operator screen should say about the configuration. */
export const getSendingIdentityReadiness = (
  environment: NodeJS.ProcessEnv = process.env
) =>
  sendingIdentityReadiness({
    transactionalFrom:
      environment.TRANSACTIONAL_EMAIL_FROM ||
      environment.EMAIL_FROM ||
      TRANSACTIONAL_FALLBACK,
    marketingFrom: environment.MARKETING_EMAIL_FROM || null,
    nodeEnv: environment.NODE_ENV,
  });

/** The domains in use, for the DNS report. Null where nothing is configured. */
export const configuredSendingDomains = (
  environment: NodeJS.ProcessEnv = process.env
) => ({
  transactional:
    parseFromAddress(
      environment.TRANSACTIONAL_EMAIL_FROM ||
        environment.EMAIL_FROM ||
        TRANSACTIONAL_FALLBACK
    )?.domain ?? null,
  marketing: parseFromAddress(environment.MARKETING_EMAIL_FROM)?.domain ?? null,
});
