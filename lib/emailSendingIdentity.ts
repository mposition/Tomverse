import "server-only";

import {
  parseFromAddress,
  replyToForSenderRole,
  resolveSenderIdentity,
  resolveSendingIdentity,
  sendingIdentityInputFrom,
  sendingIdentityReadiness,
  streamForClassification,
  type ResolvedSenderIdentity,
  type SenderRole,
  type SendingIdentityEnv,
  type SendingStream,
} from "@/lib/emailSendingIdentityCore";

/**
 * The From address each stream sends from, on the server.
 *
 * Contract: docs/policy/email-notifications.md §14.1, §5.3, §17.3.
 *
 * A thin wrapper. Every decision -- which variables are read, in what order,
 * what the fallback is, and when a stream is refused -- lives in
 * `lib/emailSendingIdentityCore.ts`, because the security-report script in
 * GitHub Actions has to reach the same answer and cannot import a `server-only`
 * module. That script and this file agreeing by construction is the point: they
 * disagreed before, and nothing noticed until the sending domain moved and only
 * one of four senders came with it.
 */

export class SendingIdentityError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SendingIdentityError";
    this.code = code;
  }
}

/**
 * The From header for a stream, throwing on a refusal.
 *
 * Marketing refuses when it has no address of its own, or one that shares the
 * transactional domain. Falling back in either case would send the promotion
 * successfully and quietly move its spam complaints onto the domain that
 * carries login codes -- a failure with no symptom until the login codes stop
 * arriving (§5.3).
 *
 * Callers that must not throw -- the operational alert paths, where one
 * channel's failure must not take the others down -- use
 * `resolveSendingIdentity` from the core directly.
 */
export const fromAddressForStream = (stream: SendingStream): string => {
  const resolved = resolveSendingIdentity(stream, process.env);
  if (!resolved.ok) {
    throw new SendingIdentityError(resolved.code, resolved.message);
  }
  return resolved.from;
};

/** The From header for a template classification. */
export const fromAddressForClassification = (classification: string) =>
  fromAddressForStream(streamForClassification(classification));

/**
 * The sender identity for one (stream, role) pair, reported rather than thrown.
 *
 * The shape the provider port uses. It returns because the port's contract is
 * that it reports -- an operator alert whose identity threw would take the
 * Slack and Discord legs of the same alert down with it
 * (docs/policy/email-notifications.md §14.1a).
 */
export const senderIdentityFor = (
  stream: SendingStream,
  role: SenderRole,
  environment: SendingIdentityEnv = process.env
): ResolvedSenderIdentity => resolveSenderIdentity(stream, role, environment);

/** The From header for one (stream, role) pair, throwing on a refusal. */
export const fromAddressForRole = (
  stream: SendingStream,
  role: SenderRole
): string => {
  const resolved = resolveSenderIdentity(stream, role, process.env);
  if (!resolved.ok) {
    throw new SendingIdentityError(resolved.code, resolved.message);
  }
  return resolved.from;
};

/**
 * Where a reply to this role should go, or null for no Reply-To header.
 *
 * Null on every deployment that has not set `EMAIL_BUSINESS_CONTACT_EMAIL`,
 * which is the behaviour that existed before roles: no Reply-To at all. See
 * `replyToForSenderRole` for why a mailbox is not invented to fill it.
 */
export const replyToForRole = (
  role: SenderRole,
  environment: SendingIdentityEnv = process.env
) => replyToForSenderRole(role, environment);

/** What a health check or an operator screen should say about the configuration. */
export const getSendingIdentityReadiness = (
  environment: SendingIdentityEnv = process.env
) => sendingIdentityReadiness(sendingIdentityInputFrom(environment));

/** The domains in use, for the DNS report. Null where nothing is configured. */
export const configuredSendingDomains = (
  environment: SendingIdentityEnv = process.env
) => {
  const input = sendingIdentityInputFrom(environment);
  return {
    transactional: parseFromAddress(input.transactionalFrom)?.domain ?? null,
    marketing: parseFromAddress(input.marketingFrom)?.domain ?? null,
  };
};
