import { readSvixHeaders, verifySvixSignature } from "@/lib/svixSignature";
import type {
  SenderRole,
  SendingStream,
} from "@/lib/emailSendingIdentityCore";

/**
 * The seam between this system and whoever puts the bytes on the wire.
 *
 * Contract: docs/policy/email-notifications.md §8.2, §9.1 step [5].
 *
 * ## Two methods, and that is the design
 *
 * `send` and `verifyWebhook`. Nothing else. Templates, contacts, segments,
 * audiences, broadcasts and automations are deliberately absent: they live in
 * our own database, and keeping them there is the thing that actually removes
 * the lock-in (§8.2). A port that grew a `createTemplate` would move the copy
 * into the provider's account, and moving provider would then mean rewriting
 * the copy rather than changing one API key.
 *
 * `EMAIL_PROVIDER_PORT_SURFACE` below names the two methods so a test can
 * assert the implementation has exactly them, and
 * `npm run check:email-provider-port` reads this file for the names it must
 * never grow. The list is the enforcement, not a comment about one.
 *
 * ## Why there is one implementation
 *
 * §8.2 again: an abstraction written while only one thing implements it takes
 * the shape of that one thing. So this is not a provider-neutral interface --
 * it is the narrowest description of what we ask a provider to do, and the
 * next provider is expected to need edits here. That is cheaper than the
 * generality we would otherwise guess at.
 *
 * ## Framework-free on purpose
 *
 * No `server-only`, no `next`, no Prisma. `lib/emailProviderPort.ts` is the
 * server binding that reads the environment; this file takes its configuration
 * as arguments so it can be driven from a test without a request, and so the
 * rules cannot be quietly re-implemented by a caller that could not import the
 * server module. That second failure is not hypothetical: three senders drifted
 * onto a stale From address exactly that way
 * (docs/ops/email-sending-domains.md §1.2).
 */

/** What the renderer produces and the provider sends. Bytes, no policy. */
export type RenderedMessage = {
  to: string;
  subject: string;
  /**
   * Optional so an operator alert can be text-only. Product mail always renders
   * both; an alert that exists to say the system is unwell has no reason to
   * carry a styled body, and inventing one would mean inventing a template for
   * it.
   */
  html?: string;
  text: string;
  /**
   * Extra message headers. Only `List-Unsubscribe` and its one-click companion
   * use this, and only on marketing mail -- §5.1 C10 forbids them on
   * transactional mail, where the link is a button that locks people out of
   * their own account.
   */
  headers?: Record<string, string>;
};

export type SendOptions = {
  /**
   * Which sending domain and which provider account this message belongs to.
   * Required, and deliberately not defaulted: a caller that does not say is a
   * caller that has not decided, and the value it would get by omission is the
   * one that carries login codes.
   */
  stream: SendingStream;
  /**
   * Who the recipient sees this message as being from.
   *
   * Required for the same reason `stream` is, and it is a *different* reason.
   * A missing stream would send a promotion down the login-code domain; a
   * missing role would send a refund decision as whoever the general identity
   * is. Neither has a safe default, so neither has one -- and because this is
   * required rather than optional, a send path added later cannot compile
   * without deciding (docs/policy/email-notifications.md §14.1a).
   *
   * The pair is checked, not just each half: a role that does not belong to
   * this stream is refused before the wire.
   */
  senderRole: SenderRole;
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
  timeoutMs?: number;
};

export type ProviderSendResult =
  | {
      ok: true;
      providerMessageId: string | null;
      /**
       * The From header the provider actually accepted.
       *
       * Reported rather than assumed by the caller, because "which address did
       * this send from" is the question nobody could answer when the
       * transactional domain moved and three of four senders stayed behind
       * (docs/ops/email-sending-domains.md §1.2). A log line that prints the
       * sender it *thinks* was used is the shape of that failure.
       */
      from: string;
      /** The role that From was resolved for, for the structured log. */
      senderRole: SenderRole;
    }
  | {
      ok: false;
      /** Absent when the request never reached a response at all. */
      status: number | null;
      retryAfterMs?: number;
      /** The transport error, when there was no response. Never a response body. */
      transportError?: unknown;
      /**
       * No API key for this stream on this deployment, so nothing was sent and
       * nothing was rejected. Kept distinct from a 401: a key the provider
       * refused is an incident on a running service, while an absent one is the
       * ordinary state of a local checkout, and a lane that conflates them
       * pages somebody every time a developer signs in.
       */
      notConfigured?: true;
      /**
       * Refused before the wire because the stream has no sending identity of
       * its own. Distinct from every provider answer: nothing was sent, nothing
       * was rejected, and retrying changes nothing until an operator sets the
       * variable (§14.1).
       */
      identityRefusal?: string;
    };

export type WebhookVerificationFailure =
  | "secret_missing"
  | "headers_missing"
  | "timestamp_invalid"
  | "timestamp_out_of_tolerance"
  | "signature_mismatch"
  | "payload_not_json";

export type WebhookVerification =
  | { ok: true; id: string; payload: unknown }
  | { ok: false; reason: WebhookVerificationFailure };

export interface EmailProviderPort {
  send(
    message: RenderedMessage,
    options: SendOptions
  ): Promise<ProviderSendResult>;
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification;
}

/**
 * The port's entire surface.
 *
 * `tests/emailProviderPort.test.mjs` asserts the implementation's own keys are
 * exactly these, so a method added to `ResendProvider` fails the build even if
 * nobody adds it to the interface. An interface is erased at runtime and would
 * enforce nothing on its own.
 */
export const EMAIL_PROVIDER_PORT_SURFACE = ["send", "verifyWebhook"] as const;

/**
 * Capabilities that belong to our database, not to the provider port.
 *
 * Read by `npm run check:email-provider-port`, which fails if any of them turns
 * up as a method name in this file. Each one is a way the provider would end up
 * holding product state: the copy, the recipient list, or who is in which
 * group.
 */
export const PORT_FORBIDDEN_CAPABILITIES = [
  "template",
  "contact",
  "segment",
  "audience",
  "broadcast",
  "automation",
  "campaign",
] as const;

/**
 * The provider account each stream sends through.
 *
 * Marketing has no fallback to the transactional key, and that is the point.
 * Resend's suppression list is account- and region-wide (§5.3.1), so a
 * promotion sent on the transactional account puts its spam complaints and its
 * unsubscribes on the same list that decides whether login codes are delivered.
 * A separate domain does not separate that; only a separate account does, and
 * which account is still an open decision (§5.3.1 decision 2, A18). Until it is
 * made, marketing refuses rather than borrows.
 *
 * The transactional stream reads a stream-specific name first and falls back to
 * `RESEND_API_KEY`, which is what every deployment sets today.
 */
export const EMAIL_PROVIDER_API_KEY_ENV_KEYS = {
  transactional: ["TRANSACTIONAL_RESEND_API_KEY", "RESEND_API_KEY"],
  marketing: ["MARKETING_RESEND_API_KEY"],
} as const satisfies Record<SendingStream, readonly string[]>;

export type ProviderEnv = Readonly<Record<string, string | undefined>>;

/**
 * A provider key read straight off an environment, found in source text.
 *
 * Pure, so `npm run check:sending-identity` can fail on one. The rule is the
 * same as the sender's and exists for the same reason: `providerApiKeyFor()`
 * prefers `TRANSACTIONAL_RESEND_API_KEY` and falls back to `RESEND_API_KEY`, so
 * a file reading the second name directly reports on -- or sends with -- a
 * credential the deployment may not be using. Four files did, and the domain
 * report's 401 was indistinguishable from a fact about the domains.
 *
 * Matches a property read (`process.env.RESEND_API_KEY`, `env["RESEND_API_KEY"]`)
 * and not a bare mention, because the admin environment screen legitimately
 * prints the variable's *name* as a label and its description says the
 * stream-specific name satisfies it too. The dot has to be adjacent for the
 * same reason: a sentence ending in one is prose, not an access.
 */
const DIRECT_PROVIDER_KEY_READ =
  /(?:\.|\[\s*["'`])(?:TRANSACTIONAL_|MARKETING_)?RESEND_API_KEY\b/g;

export type DirectProviderKeyRead = { line: number; text: string };

export const directProviderKeyReads = (
  source: string
): DirectProviderKeyRead[] => {
  const found: DirectProviderKeyRead[] = [];
  source.split("\n").forEach((line, index) => {
    // A comment explaining the rule is not a violation of it.
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    for (const match of code.matchAll(DIRECT_PROVIDER_KEY_READ)) {
      found.push({ line: index + 1, text: match[0].trim() });
    }
  });
  return found;
};

export const providerApiKeyFor = (
  stream: SendingStream,
  env: ProviderEnv
): string | null => {
  for (const key of EMAIL_PROVIDER_API_KEY_ENV_KEYS[stream]) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
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

/** The one endpoint this port posts to. Referenced by the bypass check. */
export const RESEND_SEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * One POST, reported rather than thrown.
 *
 * Deliberately says nothing about retries, suppression or idempotency policy --
 * it is the wire, and the lanes above it hold the rules.
 */
export const postToResend = async (
  message: RenderedMessage,
  config: {
    apiKey: string;
    from: string;
    senderRole: SenderRole;
    /**
     * Where a reply goes, when it is not the From address.
     *
     * Omitted entirely when absent rather than sent empty: `reply_to: null`
     * and no `reply_to` are the same to Resend today, and only one of them
     * stays true if that changes.
     */
    replyTo?: string;
    idempotencyKey?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }
): Promise<ProviderSendResult> => {
  const doFetch = config.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(RESEND_SEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        // Resend caps the key at 256 characters.
        ...(config.idempotencyKey
          ? { "Idempotency-Key": config.idempotencyKey.slice(0, 256) }
          : {}),
      },
      body: JSON.stringify({
        from: config.from,
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.headers && Object.keys(message.headers).length > 0
          ? { headers: message.headers }
          : {}),
      }),
      ...(config.timeoutMs
        ? { signal: AbortSignal.timeout(config.timeoutMs) }
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
    from: config.from,
    senderRole: config.senderRole,
  };
};

/**
 * Resend signs with Svix, so verification is the Svix scheme over the raw body.
 *
 * Returns rather than throws, and never carries the body out with it: the
 * endpoint is unauthenticated, so a rejection reason is all a log may hold.
 */
export const verifyResendWebhook = (
  rawBody: string,
  headers: Headers,
  secret: string
): WebhookVerification => {
  const verification = verifySvixSignature({
    headers: readSvixHeaders(headers),
    body: rawBody,
    secret,
  });
  if (!verification.valid) return { ok: false, reason: verification.reason };

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "payload_not_json" };
  }
  return { ok: true, id: verification.id, payload };
};
