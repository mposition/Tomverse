import "server-only";

import {
  SendingIdentityError,
  fromAddressForStream,
} from "@/lib/emailSendingIdentity";
import type { SendingStream } from "@/lib/emailSendingIdentityCore";

type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Makes a send exactly-once at the provider for 24 hours.
   *
   * Resend records the key against the request it accepted, so a retry that
   * carries the same key *and the same payload* is answered from that record
   * instead of sending again. Only accepted sends are recorded, so a genuine
   * failure still retries normally.
   *
   * This is what lets a durable retry queue be at-least-once on our side and
   * still not deliver twice: whoever owns the retry must reuse one stable key
   * per notification, and must render an identical payload every attempt.
   */
  idempotencyKey?: string;
};

/**
 * The transactional From header.
 *
 * Resolved through lib/emailSendingIdentity.ts rather than read here, so the
 * marketing stream cannot reach this value by omission: a caller that passes
 * no `stream` gets transactional, and a marketing caller has to name itself
 * and be refused if it has no domain of its own
 * (docs/policy/email-notifications.md §5.3, §14.1).
 */
const fromAddress = () => fromAddressForStream("transactional");

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
 *
 * So the status is returned. `sendTransactionalEmail` keeps its throwing shape
 * on top, and every existing caller is untouched.
 */
export type ProviderSendResult =
  | { ok: true; providerMessageId: string | null }
  | {
      ok: false;
      /** Absent when the request never reached a response at all. */
      status: number | null;
      retryAfterMs?: number;
      /** The transport error, when there was no response. Never a response body. */
      transportError?: unknown;
      /**
       * No API key on this deployment, so nothing was sent and nothing was
       * rejected. Kept distinct from a 401: a key the provider refused is an
       * incident on a running service, while an absent one is the ordinary
       * state of a local checkout, and a lane that conflates them pages
       * somebody every time a developer signs in.
       */
      notConfigured?: true;
      /**
       * The message was refused before it reached the wire because the stream
       * it belongs to has no sending identity of its own. Distinct from every
       * provider answer: nothing was sent, nothing was rejected, and retrying
       * changes nothing until an operator sets the variable
       * (docs/policy/email-notifications.md §14.1).
       */
      identityRefusal?: string;
    };

/**
 * Milliseconds a `Retry-After` header is asking for.
 *
 * The header is either delta-seconds or an HTTP date; both forms appear in the
 * wild, so both are read. An unparseable one yields undefined rather than zero:
 * "the provider said nothing useful" and "the provider said go now" are
 * different, and only the caller's own schedule should decide the first.
 */
export const parseRetryAfterMs = (
  headerValue: string | null,
  now = Date.now()
): number | undefined => {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return undefined;
  return Math.max(0, asDate - now);
};

/**
 * Posts one message and reports what happened. Never throws for an HTTP
 * status; only a transport failure produces `status: null`.
 *
 * Deliberately says nothing about retries, suppression or idempotency policy --
 * it is the wire, and the lanes above it hold the rules.
 */
export async function deliverEmailOnce(
  input: SendEmailInput & {
    /** An explicit override. Wins over `stream`; used by nothing today. */
    from?: string;
    /**
     * Which sending domain this message belongs to. Defaults to
     * transactional, which is where `service` and `legal` also send from --
     * marketing has to ask, and is refused if it has no domain of its own.
     */
    stream?: SendingStream;
    timeoutMs?: number;
    /**
     * Extra message headers. Only `List-Unsubscribe` and its one-click
     * companion use this today, and only on marketing mail --
     * docs/policy/email-notifications.md §5.1 C10 forbids
     * them on transactional mail, where the link is a button that locks people
     * out of their own account.
     */
    headers?: Record<string, string>;
  }
): Promise<ProviderSendResult> {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    // No status, because no request was made. Not retried either: waiting
    // cannot conjure a key, and the caller decides how loudly to say so.
    return { ok: false, status: null, notConfigured: true };
  }

  // Resolved before the request rather than inside the body, so a stream with
  // no domain of its own is reported as itself instead of throwing out of a
  // function whose whole contract is that it reports rather than throws.
  let from: string;
  try {
    from = input.from || fromAddressForStream(input.stream || "transactional");
  } catch (error) {
    return {
      ok: false,
      status: null,
      identityRefusal:
        error instanceof SendingIdentityError ? error.code : "IDENTITY_UNRESOLVED",
    };
  }

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
        // Resend caps the key at 256 characters.
        ...(input.idempotencyKey
          ? { "Idempotency-Key": input.idempotencyKey.slice(0, 256) }
          : {}),
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.headers && Object.keys(input.headers).length > 0
          ? { headers: input.headers }
          : {}),
      }),
      ...(input.timeoutMs
        ? { signal: AbortSignal.timeout(input.timeoutMs) }
        : {}),
    });
  } catch (transportError) {
    return { ok: false, status: null, transportError };
  }

  if (!response.ok) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
    // Read and drop it. The body may name the recipient, and an unread body
    // holds the connection open (see lib/apiCacheControlPolicy.ts).
    await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }

  const body = (await response.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  return {
    ok: true,
    providerMessageId: typeof body?.id === "string" ? body.id : null,
  };
}

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

  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.warn(
      JSON.stringify({
        event: "transactional_email_skipped",
        reason: "RESEND_API_KEY missing",
        to: input.to,
        subject: input.subject,
      })
    );
    return { sent: false, skipped: true };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      // Resend caps the key at 256 characters.
      ...(input.idempotencyKey
        ? { "Idempotency-Key": input.idempotencyKey.slice(0, 256) }
        : {}),
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Email send failed: ${response.status} ${body.slice(0, 300)}`);
  }

  const responseBody = (await response.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  console.info(
    JSON.stringify({
      event: "transactional_email_sent",
      provider: "resend",
      id: typeof responseBody?.id === "string" ? responseBody.id : null,
      to: input.to,
      subject: input.subject,
      from: fromAddress(),
    })
  );

  return { sent: true, skipped: false, id: responseBody?.id || null };
}
