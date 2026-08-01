import {
  classifyFeedbackFailure,
  feedbackReferenceFromId,
  isFeedbackReference,
  type FeedbackSubmitFailure,
} from "@/lib/feedbackPolicy";

/**
 * The one client-side path to POST /api/feedback.
 *
 * Both feedback surfaces -- the chat "Send feedback" modal and the marketing
 * support form -- go through this, so they can never drift into describing the
 * same HTTP result differently. Two rules hold here:
 *
 *  - nothing from the response body reaches the user as copy. Only the status
 *    and a strictly shaped error `code` are read, and both are mapped onto a
 *    closed set of failures the locale files own.
 *  - a Turnstile token is passed through and never stored, logged or echoed.
 */

/** A hung request must not leave the modal locked open forever. */
const REQUEST_TIMEOUT_MS = 30_000;

export type FeedbackSubmitPayload = {
  type: string;
  message: string;
  email?: string;
  traceId?: string;
  modelId?: string;
  plan?: string;
  hasAttachments?: boolean;
  attachmentCount?: number;
  path?: string;
  userAgent?: string;
  turnstileToken?: string;
};

export type FeedbackSubmitOutcome =
  | {
      ok: true;
      feedbackId: string | null;
      /** Short handle worth showing the user; null when the server sent none. */
      reference: string | null;
    }
  | {
      ok: false;
      failure: FeedbackSubmitFailure;
      status: number | null;
      /** Only present for failures a user may need to quote back to support. */
      reference: string | null;
    };

const randomReference = () => {
  const bytes = new Uint8Array(4);
  const webCrypto =
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
      ? globalThis.crypto
      : null;
  if (webCrypto) {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
};

const readJsonSafely = async (response: Response) => {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * Operational breadcrumb for a failed submission. Carries the classification
 * and the reference the user was shown -- never the message, the trace ID, the
 * Turnstile token or any part of the response body.
 */
const logFailure = (
  failure: FeedbackSubmitFailure,
  status: number | null,
  reference: string | null
) => {
  console.warn(
    JSON.stringify({
      event: "feedback_submit_failed",
      failure,
      status,
      reference,
      at: new Date().toISOString(),
    })
  );
};

export async function submitFeedback(
  payload: FeedbackSubmitPayload
): Promise<FeedbackSubmitOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    logFailure("network", null, null);
    return { ok: false, failure: "network", status: null, reference: null };
  } finally {
    clearTimeout(timeout);
  }

  if (response.ok) {
    const body = await readJsonSafely(response);
    const feedbackId =
      typeof body?.feedbackId === "string" && body.feedbackId.length <= 64
        ? body.feedbackId
        : null;
    const reference = isFeedbackReference(body?.reference)
      ? body.reference
      : feedbackId
        ? feedbackReferenceFromId(feedbackId)
        : null;
    return { ok: true, feedbackId, reference };
  }

  const body = await readJsonSafely(response);
  const code = typeof body?.code === "string" ? body.code : null;
  const failure = classifyFeedbackFailure(response.status, code);
  // A reference only helps where the user cannot act on the cause themselves.
  const reference =
    failure === "unknown" || failure === "server" ? randomReference() : null;
  logFailure(failure, response.status, reference);
  return { ok: false, failure, status: response.status, reference };
}
