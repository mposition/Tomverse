/**
 * The Zernio webhook, as the staging shadow receiver reads it (S2 plan, S2e).
 *
 * Pure: no database, no request object, no credential held. The route reads the
 * secret and the raw body and hands them here; the store writes what this
 * decides. Everything a person could get wrong about a webhook is here, in one
 * place that a test can reach without a server.
 *
 * ## What the S0 record establishes, and what follows from it
 *
 * - `X-Zernio-Signature` is the HMAC-SHA256 of the **raw body**, lowercase hex,
 *   sent only when the subscription has a secret. So the signature is checked
 *   over the exact bytes received, before anything parses them, and a missing
 *   header is a refusal -- the receiver's subscription always has a secret.
 * - `X-Zernio-Event-Id` equals the payload's `id` and is the same on every
 *   retry and redelivery. It is the dedupe key, and the header and the body must
 *   agree: a body whose id differs from its header is not one event.
 * - The timestamp is **not** signed and has no stated tolerance, so it is not
 *   used to decide anything. Replay is handled by the event id, not by time.
 *
 * ## What this is not
 *
 * Shadow only. Nothing here changes a post: S2f applies events, and only after
 * the staging evidence is signed.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  resolveDeploymentEnvironment,
} from "@/lib/deploymentEnvironment";
import {
  MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES,
  MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR,
  MARKETING_WEBHOOK_SCHEMA_VERSION,
  MARKETING_WEBHOOK_SHADOW_KEY,
  canonicalMarketingWebhookJson,
  computeMarketingWebhookConfigSnapshotDigest,
  marketingWebhookEnvDigests,
} from "@/lib/marketingAutomationAccess";
import type { MarketingPostStatus } from "@/lib/marketingAutomationSchema";

export const MARKETING_WEBHOOK_PROVIDER = "zernio";

/**
 * The post events the shadow receiver records.
 *
 * Post events only: account and comment events are not about a post's status,
 * and the shadow report is a statement about one. An event outside this list is
 * acknowledged and not recorded, rather than refused, because refusing it would
 * make Zernio retry something nobody wants.
 */
export const MARKETING_WEBHOOK_EVENT_TYPES = [
  "post.published",
  "post.failed",
  "post.partial",
  "post.cancelled",
  "post.platform.published",
  "post.platform.failed",
  "post.platform.deleted",
] as const;

export type MarketingWebhookEventType = (typeof MARKETING_WEBHOOK_EVENT_TYPES)[number];

/**
 * The status a post would have if this event were applied.
 *
 * - `partial` is not a success: some platform did not publish, and for a post
 *   sent to one platform that is the case the publisher records as
 *   `outcome_unknown` too.
 * - `cancelled` is a retraction made *through Zernio* -- by us or an operator --
 *   so it maps to our own `deleted`, never to removal by the platform.
 * - `post.platform.deleted` is the platform's act, reported by Zernio's own
 *   hourly poll, and is the only event that maps to `removed_by_platform`.
 */
export const MARKETING_WEBHOOK_DERIVED_STATUS: Readonly<
  Record<MarketingWebhookEventType, MarketingPostStatus>
> = Object.freeze({
  "post.published": "published",
  "post.platform.published": "published",
  "post.failed": "failed",
  "post.platform.failed": "failed",
  "post.partial": "outcome_unknown",
  "post.cancelled": "deleted",
  "post.platform.deleted": "removed_by_platform",
});

/**
 * Whether the raw body carries the signature the subscription's secret makes.
 *
 * Over the bytes as received, before parsing: a body re-serialised by a parser
 * is not the body that was signed. Exactly 64 lowercase hex characters, compared
 * in constant time; anything else is a refusal, including a missing header or
 * an empty secret.
 */
export const verifyZernioWebhookSignature = (
  rawBody: Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string | null | undefined,
): boolean => {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof signatureHeader !== "string") return false;
  const provided = signatureHeader.trim();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(provided, "hex"));
};

/**
 * The event's identity, as stored: `sha256` over the provider and the event id.
 *
 * Over a canonical two-element JSON array rather than a concatenation, so no
 * pair of provider and id can collide with another by moving a separator.
 */
export const marketingWebhookEventIdDigest = (provider: string, eventId: string): string =>
  createHash("sha256").update(JSON.stringify([provider, eventId]), "utf8").digest("hex");

/** An account id as Zernio sends it: a string, or an object carrying one. */
const accountIdSchema = z.union([
  z.string().min(1),
  z
    .object({ _id: z.string().min(1).optional(), id: z.string().min(1).optional() })
    .refine((value) => value._id !== undefined || value.id !== undefined),
]);

/**
 * Two envelope families, because Zernio routes them differently.
 *
 * Zernio's account-routing contract: an **aggregate** post event
 * (`post.published`, `post.failed`, ...) names its targets in
 * `post.platforms[].accountId`, one per target, with no top-level account; a
 * **per-platform** event (`post.platform.*`) names the one target it is about in
 * `account.accountId`, while its `post.platforms[]` still lists every target.
 * The first version read every event as the aggregate shape and picked from
 * `post.platforms[]` -- so a per-platform failure for account B on a post sent to
 * A and B would have been recorded against A.
 *
 * Each family's schema requires and types every field this module reads. They
 * are not `.strict()` over Zernio's whole object: the S0 record does not list
 * every field the provider sends, and refusing an event for one we do not read
 * would turn a provider release into a dead-lettered subscription. Nothing a
 * schema does not name is read.
 */
const AGGREGATE_EVENT_TYPES = [
  "post.published",
  "post.failed",
  "post.partial",
  "post.cancelled",
] as const satisfies readonly MarketingWebhookEventType[];

const PLATFORM_EVENT_TYPES = [
  "post.platform.published",
  "post.platform.failed",
  "post.platform.deleted",
] as const satisfies readonly MarketingWebhookEventType[];

const envelopeBase = {
  id: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
};

const aggregateEnvelopeSchema = z.object({
  ...envelopeBase,
  event: z.enum(AGGREGATE_EVENT_TYPES),
  post: z.object({
    id: z.string().min(1),
    status: z.string().min(1),
    platforms: z
      .array(z.object({ platform: z.string().min(1), accountId: accountIdSchema }))
      .min(1),
  }),
});

const platformEnvelopeSchema = z.object({
  ...envelopeBase,
  event: z.enum(PLATFORM_EVENT_TYPES),
  account: z.object({ accountId: accountIdSchema }),
  post: z.object({ id: z.string().min(1) }),
});

const accountIdOf = (value: z.infer<typeof accountIdSchema>): string =>
  typeof value === "string" ? value : (value._id ?? value.id ?? "");

export type MarketingWebhookEnvelope = {
  readonly eventId: string;
  readonly eventType: MarketingWebhookEventType;
  readonly zernioPostId: string;
  /** The one platform account this event is about. */
  readonly accountId: string;
};

export type MarketingWebhookParseRefusal =
  | "body_not_json"
  | "event_not_recorded"
  | "envelope_invalid"
  | "event_id_header_mismatch"
  /**
   * An aggregate event for a post sent to more than one account. Every post
   * this system makes goes to one, so the event is not about one of ours in a
   * way a single channel can answer for.
   */
  | "multiple_targets";

/**
 * Read a signed body, or say why it cannot be read.
 *
 * Called only after the signature has verified. An event type outside the
 * recorded list is `event_not_recorded` -- a reason to acknowledge without
 * storing, not an error. The header's event id must equal the body's.
 */
export const parseZernioWebhookEnvelope = (
  rawBody: Uint8Array,
  eventIdHeader: string | null | undefined,
):
  | { readonly ok: true; readonly envelope: MarketingWebhookEnvelope }
  | { readonly ok: false; readonly refusal: MarketingWebhookParseRefusal } => {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return { ok: false, refusal: "body_not_json" };
  }
  const event = (json as { event?: unknown } | null)?.event;
  if (
    typeof event === "string" &&
    !(MARKETING_WEBHOOK_EVENT_TYPES as readonly string[]).includes(event)
  ) {
    return { ok: false, refusal: "event_not_recorded" };
  }
  const family = (PLATFORM_EVENT_TYPES as readonly string[]).includes(String(event))
    ? platformEnvelopeSchema
    : aggregateEnvelopeSchema;
  const parsed = family.safeParse(json);
  if (!parsed.success) return { ok: false, refusal: "envelope_invalid" };
  const data = parsed.data;
  if (typeof eventIdHeader !== "string" || eventIdHeader.trim() !== data.id) {
    return { ok: false, refusal: "event_id_header_mismatch" };
  }
  let accountId: string;
  if ("account" in data) {
    accountId = accountIdOf(data.account.accountId);
  } else {
    const targets = [...new Set(data.post.platforms.map((entry) => accountIdOf(entry.accountId)))];
    if (targets.length !== 1) return { ok: false, refusal: "multiple_targets" };
    accountId = targets[0] ?? "";
  }
  if (accountId === "") return { ok: false, refusal: "envelope_invalid" };
  return {
    ok: true,
    envelope: {
      eventId: data.id,
      eventType: data.event,
      zernioPostId: data.post.id,
      accountId,
    },
  };
};

/**
 * Whether a status query about the event's own account agrees with the status
 * the event implies.
 *
 * Each answer agrees with one thing: `live` with `published`, `removed` with
 * removal by the platform, `not_live` (failed, or retracted through the
 * provider) with every other non-published status. `unknown` agrees with
 * nothing: a query that could not say is not a confirmation of either.
 */
export const marketingWebhookStatusQueryMatch = (
  derived: MarketingPostStatus,
  state: "live" | "not_live" | "removed" | "unknown",
): boolean => {
  if (state === "unknown") return false;
  if (derived === "published") return state === "live";
  if (derived === "removed_by_platform") return state === "removed";
  return state === "not_live";
};

/**
 * Why a staging webhook setting was not changed.
 *
 * Here rather than beside the writers: the admin routes name it in `instanceof`
 * outside the mutation runner's transaction, and this module reaches no store,
 * so naming it there loads nothing that writes.
 */
export class MarketingWebhookSettingRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MarketingWebhookSettingRefusedError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

/**
 * Whether this process is staging, by both signals and nothing weaker.
 *
 * `TOMVERSE_DEPLOY_ENV` and the resolved deployment environment must both say
 * `staging` -- the same two the access resolver's `webhookShadow` decision reads.
 * Production says production, and an unlabelled build resolves to production,
 * so neither path can reach the shadow writer or the deliberate failure.
 */
export const marketingWebhookIsStaging = (env: NodeJS.ProcessEnv = process.env): boolean =>
  String(env.TOMVERSE_DEPLOY_ENV ?? "").trim().toLowerCase() === "staging" &&
  resolveDeploymentEnvironment(env) === "staging";

/**
 * The staging configuration snapshot digest (S1 r7 amendment 1): the shadow
 * switch's stored value, the accepted event list, the schema version and the
 * hashes of the declared environment values -- and which Zernio account each
 * channel answers for. One function for the receiver, which stamps it on every
 * signed answer, and the record drafter, which keeps only attempts stamped with
 * the digest it records.
 */
export type MarketingWebhookChannelBinding = {
  readonly id: string;
  readonly externalAccountRef: string;
};

export const marketingWebhookStagingConfigSnapshotDigest = (
  env: Readonly<Record<string, string | undefined>>,
  shadowValue: string | null,
  channels: readonly MarketingWebhookChannelBinding[],
): string =>
  createHash("sha256")
    .update(
      canonicalMarketingWebhookJson({
        snapshot: computeMarketingWebhookConfigSnapshotDigest({
          appSettings: { [MARKETING_WEBHOOK_SHADOW_KEY]: shadowValue },
          acceptedEventTypes: [...MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES],
          envDigests: marketingWebhookEnvDigests(env, MARKETING_WEBHOOK_PIPELINE_DESCRIPTOR.envNames),
          schemaVersion: MARKETING_WEBHOOK_SCHEMA_VERSION,
        }),
        // Reconnecting a channel to another account changes the digest, so
        // evidence observed through the old account never certifies the new one.
        channels: channels
          .map((channel) => JSON.stringify([channel.id, channel.externalAccountRef]))
          .sort(),
      }),
      "utf8",
    )
    .digest("hex");

// ---------------------------------------------------------------------------
// The fault arm
// ---------------------------------------------------------------------------

export const MARKETING_WEBHOOK_FAULT_ARM_KEY = "marketingAutomation.webhookFaultArm";

/** The longest an arm may stay armed. A test that is not run should not linger. */
export const MARKETING_WEBHOOK_FAULT_ARM_MAX_MS = 24 * 60 * 60 * 1000;

const isoInstant = z.string().datetime({ offset: false });

/** The plan's `WebhookFaultArm`, exactly. */
export const marketingWebhookFaultArmSchema = z
  .object({
    eventIdDigest: z.string().regex(/^[0-9a-f]{64}$/),
    state: z.enum(["armed", "consumed"]),
    generation: z.number().int().positive(),
    armedAt: isoInstant,
    expiresAt: isoInstant,
  })
  .strict()
  .refine((arm) => Date.parse(arm.expiresAt) > Date.parse(arm.armedAt), {
    message: "expiresAt must be after armedAt",
  });

export type MarketingWebhookFaultArm = z.infer<typeof marketingWebhookFaultArmSchema>;

/** A stored value, or null when absent or not exactly an arm. */
export const parseMarketingWebhookFaultArm = (
  value: string | null | undefined,
): MarketingWebhookFaultArm | null => {
  if (typeof value !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return null;
  }
  const parsed = marketingWebhookFaultArmSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
};

/** The one serialisation an arm is stored and compared in. */
export const serializeMarketingWebhookFaultArm = (arm: MarketingWebhookFaultArm): string =>
  JSON.stringify({
    eventIdDigest: arm.eventIdDigest,
    state: arm.state,
    generation: arm.generation,
    armedAt: arm.armedAt,
    expiresAt: arm.expiresAt,
  });

/**
 * Whether this signed event should trip the latch: armed, for exactly this
 * event, and not yet expired at the database clock.
 */
export const marketingWebhookFaultArmMatches = (
  arm: MarketingWebhookFaultArm | null,
  eventIdDigest: string,
  now: Date,
): arm is MarketingWebhookFaultArm =>
  arm !== null &&
  arm.state === "armed" &&
  arm.eventIdDigest === eventIdDigest &&
  Date.parse(arm.expiresAt) > now.getTime();
