import "server-only";

import { emailProvider } from "@/lib/emailProviderPort";
import type {
  ProviderSendResult,
  RenderedMessage,
} from "@/lib/emailProviderPortCore";
import type { SendingStream } from "@/lib/emailSendingIdentityCore";

/**
 * What the lanes call to send one message.
 *
 * Contract: docs/policy/email-notifications.md §8.2, §9.1 step [5].
 *
 * The wire itself moved to `lib/emailProviderPort.ts` and its framework-free
 * core. This file used to hold two copies of that call -- `deliverEmailOnce`
 * and `sendTransactionalEmail` each built their own request, and the second
 * quietly lacked the header support and the response-body drain the first had.
 * Two copies of a provider call is how a sender stops matching the rules
 * without anyone noticing (docs/ops/email-sending-domains.md §1.2), so there is
 * now one, and both functions here are shapes over it.
 */

type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** See `SendOptions.idempotencyKey` in lib/emailProviderPortCore.ts. */
  idempotencyKey?: string;
};

export type { ProviderSendResult };

/**
 * One attempt at the provider, reported rather than thrown.
 *
 * `sendTransactionalEmail` below throws on a failed send, which suited callers
 * whose only recovery was a queue: the queue caught the throw and re-read the
 * status out of the message with a regular expression. The credential lane
 * cannot work that way -- it has to decide, inside the request, whether this
 * particular status is worth another 700ms of the user's time -- and rebuilding
 * a status by parsing an error string is a decision made on a value that was
 * already thrown away once.
 */
export async function deliverEmailOnce(
  input: SendEmailInput & {
    /**
     * Which sending domain and provider account this message belongs to.
     * Defaults to transactional, which is where `service` and `legal` also send
     * from -- marketing has to ask, and is refused if it has no domain or
     * account of its own.
     */
    stream?: SendingStream;
    timeoutMs?: number;
    /** See `RenderedMessage.headers` in lib/emailProviderPortCore.ts. */
    headers?: Record<string, string>;
  }
): Promise<ProviderSendResult> {
  const message: RenderedMessage = {
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    ...(input.headers ? { headers: input.headers } : {}),
  };
  return emailProvider().send(message, {
    stream: input.stream ?? "transactional",
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
}

/**
 * The throwing shape, for callers whose recovery is a queue.
 *
 * `lib/notificationRetryCore.ts` reads the status back out of the message with
 * `/Email send failed:\s*(\d{3})/`, so that prefix and that number are a
 * contract with it. The provider's response body is no longer appended: it can
 * name the recipient, nothing parses it, and it was ending up in a stored
 * `lastError`.
 */
export async function sendTransactionalEmail(input: SendEmailInput) {
  if (!input.to) {
    console.warn(
      JSON.stringify({
        event: "transactional_email_skipped",
        reason: "recipient missing",
        subject: input.subject,
      })
    );
    return { sent: false, skipped: true };
  }

  const result = await deliverEmailOnce({ ...input, stream: "transactional" });

  if (!result.ok) {
    if (result.notConfigured) {
      console.warn(
        JSON.stringify({
          event: "transactional_email_skipped",
          reason: "no provider API key for the transactional stream",
          to: input.to,
          subject: input.subject,
        })
      );
      return { sent: false, skipped: true };
    }
    if (result.identityRefusal) {
      throw new Error(
        `Email send failed: sending identity unusable (${result.identityRefusal})`
      );
    }
    if (result.status === null) {
      throw new Error(
        `Email send failed: no response from the provider${
          result.transportError instanceof Error
            ? ` (${result.transportError.name})`
            : ""
        }`
      );
    }
    throw new Error(`Email send failed: ${result.status}`);
  }

  console.info(
    JSON.stringify({
      event: "transactional_email_sent",
      provider: "resend",
      id: result.providerMessageId,
      to: input.to,
      subject: input.subject,
      from: result.from,
    })
  );

  return { sent: true, skipped: false, id: result.providerMessageId };
}
