import "server-only";

import {
  SendingIdentityError,
  fromAddressForStream,
} from "@/lib/emailSendingIdentity";
import {
  postToResend,
  providerApiKeyFor,
  verifyResendWebhook,
  type EmailProviderPort,
  type ProviderSendResult,
  type RenderedMessage,
  type SendOptions,
  type WebhookVerification,
} from "@/lib/emailProviderPortCore";

/**
 * The one provider implementation, bound to this deployment's environment.
 *
 * Contract: docs/policy/email-notifications.md §8.2, §9.1 step [5].
 *
 * A thin binding, in the same shape as `lib/emailSendingIdentity.ts`: every
 * decision -- which key each stream uses, what the wire call looks like, how a
 * webhook is verified -- lives in `lib/emailProviderPortCore.ts`, and this file
 * supplies `process.env` and the resolved From address. The split exists so the
 * rules can be driven by a test without a request, and so nothing that cannot
 * import a `server-only` module has a reason to write its own copy of them.
 */

export class ResendProvider implements EmailProviderPort {
  async send(
    message: RenderedMessage,
    options: SendOptions
  ): Promise<ProviderSendResult> {
    const apiKey = providerApiKeyFor(options.stream, process.env);
    if (!apiKey) {
      // No status, because no request was made. Not retried either: waiting
      // cannot conjure a key, and the caller decides how loudly to say so.
      return { ok: false, status: null, notConfigured: true };
    }

    // Resolved before the request rather than inside the body, so a stream with
    // no domain of its own is reported as itself instead of throwing out of a
    // method whose whole contract is that it reports rather than throws.
    let from: string;
    try {
      from = fromAddressForStream(options.stream);
    } catch (error) {
      return {
        ok: false,
        status: null,
        identityRefusal:
          error instanceof SendingIdentityError
            ? error.code
            : "IDENTITY_UNRESOLVED",
      };
    }

    return postToResend(message, {
      apiKey,
      from,
      ...(options.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    // Distinct from a bad signature. Nothing is wrong with the request, so the
    // endpoint answers 503 and the provider keeps retrying -- events queue at
    // Resend rather than being dropped while a deployment misses its secret.
    if (!secret) return { ok: false, reason: "secret_missing" };
    return verifyResendWebhook(rawBody, headers, secret);
  }
}

const provider = new ResendProvider();

/** The provider every sender goes through. One instance, no routing. */
export const emailProvider = (): EmailProviderPort => provider;
