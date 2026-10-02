/**
 * The staging shadow receiver for Zernio webhooks (S2 plan, S2e).
 *
 * The route reads the secret and builds what this needs; this decides, in an
 * order the plan fixes:
 *
 *   1. **Staging, or nothing.** Anywhere else the receiver answers 404 before it
 *      reads the body: production has no shadow and no deliberate failure, and
 *      S2f -- which applies events -- is not built.
 *   2. **Signature over the raw bytes**, before anything parses them.
 *   3. **The envelope**, with the header's event id equal to the body's.
 *   4. **The fault latch**, in its own transaction, committed before the
 *      deliberate 5xx and before any shadow storage -- so the retry finds it
 *      spent and goes on normally.
 *   5. **The shadow report**, only while the shadow switch is on, for an event
 *      about an account this system has; a second delivery of the same event is
 *      answered as already recorded.
 *
 * Nothing here changes a post. The secret and the provider key never reach
 * this module as values it stores or logs.
 */

import {
  MARKETING_WEBHOOK_DERIVED_STATUS,
  MARKETING_WEBHOOK_PROVIDER,
  marketingWebhookEventIdDigest,
  marketingWebhookStatusQueryMatch,
  parseZernioWebhookEnvelope,
  verifyZernioWebhookSignature,
} from "@/lib/marketingWebhookCore";
import type { MarketingPublishAdapter } from "@/lib/marketingPublishAdapter";

/** The largest body read. Zernio's post events are a few kilobytes. */
export const MARKETING_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export type MarketingWebhookReceiverDeps = {
  /** Whether this process is staging, by both signals. */
  readonly isStaging: () => boolean;
  /**
   * Whether the operator's kill switch is set. It stops everything but reading
   * the record (docs/policy/marketing-automation.md §6.1): no latch consumed, no
   * deliberate failure, no report, no status query.
   */
  readonly killSwitchOn: () => boolean;
  /** `ZERNIO_WEBHOOK_SECRET`, read by the route; absent means every delivery is refused. */
  readonly secret: string | undefined;
  /** For the status query a shadow report compares against; null without a key. */
  readonly adapter: MarketingPublishAdapter | null;
  readonly consumeFaultArm: (eventIdDigest: string) => Promise<{ readonly consumed: boolean }>;
  /**
   * This build's webhook pipeline fingerprint. Every answer carries it, so
   * Zernio's delivery log -- which keeps each response body -- shows which
   * build handled which attempt. A verification record counts only attempts
   * the current build answered (policy §8.1.1: a change re-opens verification).
   */
  readonly pipelineFingerprint: string;
  /**
   * One read of the configuration a signed delivery is handled under: the
   * shadow switch's stored value, the Zernio channels and the digest of both
   * (with the environment). The stamp, the shadow decision and the channel
   * lookup all come from this one read, so an answer can never name a
   * configuration other than the one that decided it.
   */
  readonly readSnapshot: () => Promise<{
    readonly shadowValue: string | null;
    readonly channels: ReadonlyArray<{ readonly id: string; readonly externalAccountRef: string }>;
    readonly configDigest: string;
  }>;
  readonly recordShadow: (input: {
    readonly eventIdDigest: string;
    readonly eventType: string;
    readonly channelId: string;
    readonly derivedStatus: string;
    readonly statusQueryMatch: boolean;
  }) => Promise<"recorded" | "duplicate">;
};

const json = (body: Record<string, unknown>, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * The body, read chunk by chunk and abandoned the moment it passes the limit.
 *
 * Not `arrayBuffer()`: that buffers the whole body before anything can count
 * it, so a request with no length -- or a false one -- is held in memory to
 * whatever size its sender chooses before it is refused, and the sender has not
 * been authenticated yet. Here the stream is cancelled at the first chunk over.
 */
const readBody = async (request: Request): Promise<Uint8Array | null> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MARKETING_WEBHOOK_MAX_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MARKETING_WEBHOOK_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export async function handleZernioWebhook(
  request: Request,
  deps: MarketingWebhookReceiverDeps,
): Promise<Response> {
  if (!deps.isStaging()) {
    return json({ code: "not_found" }, 404);
  }
  // Every answer from here names the build that gave it; Zernio's log keeps it.
  const pipeline = deps.pipelineFingerprint;
  const unsigned = (answer: Record<string, unknown>, status: number) =>
    json({ ...answer, pipeline }, status);

  // The kill switch, before the body is read: nothing is consumed, recorded or
  // asked of the provider. A 2xx, so the provider does not spend its retries on
  // a stop an operator chose.
  if (deps.killSwitchOn()) {
    return unsigned({ status: "kill_switch" }, 200);
  }

  const raw = await readBody(request);
  if (raw === null) return unsigned({ code: "body_too_large" }, 413);

  if (!verifyZernioWebhookSignature(raw, request.headers.get("x-zernio-signature"), deps.secret)) {
    // Counted in the log by code only: no header value, no body, no secret.
    console.warn("marketing_webhook_signature_refused");
    return unsigned({ code: "signature_invalid" }, 401);
  }

  const parsed = parseZernioWebhookEnvelope(raw, request.headers.get("x-zernio-event-id"));
  if (!parsed.ok) {
    if (parsed.refusal === "event_not_recorded" || parsed.refusal === "multiple_targets") {
      // Signed, and not something a single channel of ours can answer for. 2xx
      // so the provider does not retry something nobody wants.
      return unsigned({ status: "ignored", reason: parsed.refusal }, 200);
    }
    return unsigned({ code: parsed.refusal }, 400);
  }

  // A signed event of ours from here, so the answer also carries the
  // configuration it ran under -- read once, before the latch, and used for
  // every decision below.
  const snapshot = await deps.readSnapshot();
  const signed = (answer: Record<string, unknown>, status: number) =>
    json({ ...answer, pipeline, config: snapshot.configDigest }, status);
  const envelope = parsed.envelope;
  const eventIdDigest = marketingWebhookEventIdDigest(MARKETING_WEBHOOK_PROVIDER, envelope.eventId);

  // The latch, before anything is stored. Its own transaction commits first, so
  // the deliberate failure is answered only after the latch is spent.
  const fault = await deps.consumeFaultArm(eventIdDigest);
  if (fault.consumed) {
    return signed({ code: "deliberate_fault", eventIdDigest }, 503);
  }

  if (snapshot.shadowValue !== "true") {
    return signed({ status: "shadow_off" }, 200);
  }

  // One account, one channel. None is not ours; several is not one answer.
  const holders = snapshot.channels.filter(
    (candidate) => candidate.externalAccountRef === envelope.accountId,
  );
  const channel = holders.length === 1 ? holders[0] : null;
  if (!channel) {
    return signed({ status: "channel_unknown" }, 200);
  }

  const derivedStatus = MARKETING_WEBHOOK_DERIVED_STATUS[envelope.eventType];
  let state: "live" | "not_live" | "removed" | "unknown" = "unknown";
  if (deps.adapter) {
    try {
      const answer = await deps.adapter.lookupStatus(envelope.zernioPostId, envelope.accountId);
      state = answer.state;
    } catch {
      state = "unknown";
    }
  }

  const outcome = await deps.recordShadow({
    eventIdDigest,
    eventType: envelope.eventType,
    channelId: channel.id,
    derivedStatus,
    statusQueryMatch: marketingWebhookStatusQueryMatch(derivedStatus, state),
  });
  return signed({ status: outcome }, 200);
}
