/**
 * The things a marketing post is allowed to assert, and what each one rests on.
 *
 * Contract: docs/policy/marketing-automation.md §2 and §7. A claim is a
 * registered statement with a locale key, a life, and -- for the kinds where it
 * is possible -- a piece of evidence that can be checked mechanically. The
 * Guard resolves a draft's claim ids against this registry; a sentence that
 * asserts something with no claim behind it is not publishable.
 *
 * Two properties are the point of the shape, and both are stated in the policy:
 *
 * **The generator never sees the evidence** (§2). It receives
 * `generatorProjection()`, which is the registry with every `evidence` field
 * removed. A model that could read the evidence could write copy that matches
 * it without the claim being true -- the evidence would stop being a check and
 * start being a prompt. Verification happens after generation, against the
 * registry this module keeps.
 *
 * **A feature claim's evidence is the page itself** (S1 plan, B2). For
 * `feature` and `availability`, `statementKey` is a locale string key used by a
 * named public marketing route, and the rendered sentence *is* that string.
 * There is no stored quotation to drift: if the page changes, the claim changes
 * with it or stops resolving. Nothing external is ever quoted into this
 * registry -- a competitor comparison stores a URL and a scope, and the reading
 * of it is a human's.
 *
 * The registry is empty. Claims are added by a person with the evidence in
 * front of them, which is why this ships as a validated shape and a resolver
 * rather than as content.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

import { z } from "zod";

import { MARKETING_LOCALES } from "@/lib/marketingAutomationSchema";

/**
 * What a claim is about. The kinds differ in what can be checked, which is the
 * only reason they are separate:
 *
 * - `pricing`, `plan`, `model` resolve against stored rows this application
 *   already owns, so the Guard can compare a claim to the fact;
 * - `feature`, `availability` resolve against a public page's own words;
 * - `comparison` names somebody else's page, which no code can read for
 *   meaning, so it carries a URL and a scope and is always a human decision
 *   (§7.4: competitor names and comparisons are always approved).
 */
export const MARKETING_CLAIM_TYPES = [
  "pricing",
  "plan",
  "model",
  "feature",
  "comparison",
  "availability",
] as const;
export type MarketingClaimType = (typeof MARKETING_CLAIM_TYPES)[number];

/** The claim kinds whose evidence is a string on one of our own pages. */
export const MARKETING_PAGE_EVIDENCE_TYPES = ["feature", "availability"] as const;

const registryId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/);

const localeKey = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/);

const isoDate = z.iso.date();

/**
 * Evidence that lives on one of our pages: a route and the locale key of the
 * string on it. The rendered claim is that string, so there is nothing here to
 * compare against a copy of it.
 */
const pageEvidenceSchema = z
  .object({
    kind: z.literal("page"),
    pageRoute: z
      .string()
      .min(1)
      .max(200)
      .regex(/^\/[A-Za-z0-9/-]*$/),
    localeKey,
  })
  .strict();

/**
 * Evidence that lives on somebody else's page: where it was read and what part
 * of it the claim is about. Never the text -- a stored quotation is a copy that
 * ages silently, and reading a competitor's page for meaning is a person's job.
 */
const externalEvidenceSchema = z
  .object({
    kind: z.literal("external"),
    url: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          return new URL(value).protocol === "https:";
        } catch {
          return false;
        }
      }, "must be an https URL"),
    scope: z.string().max(120).regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/),
    readAt: isoDate,
  })
  .strict();

export const marketingClaimEvidenceSchema = z.discriminatedUnion("kind", [
  pageEvidenceSchema,
  externalEvidenceSchema,
]);
export type MarketingClaimEvidence = z.infer<typeof marketingClaimEvidenceSchema>;

export const marketingClaimSchema = z
  .object({
    id: registryId,
    type: z.enum(MARKETING_CLAIM_TYPES),
    /**
     * The locale key of the sentence this claim is. For a page-evidence claim
     * it is also the key of the evidence, which is what makes the rendered
     * claim and the evidence the same bytes.
     */
    statementKey: localeKey,
    locales: z.array(z.enum(MARKETING_LOCALES)).min(1),
    validUntil: isoDate,
    /**
     * A feature flag the claim depends on. A claim about something that is
     * behind a flag is only true while the flag is on, and a flag nobody can
     * read resolves to not-public rather than to true.
     */
    gate: registryId.nullable(),
    evidence: marketingClaimEvidenceSchema.nullable(),
  })
  .strict()
  .superRefine((claim, context) => {
    const needsPageEvidence = (
      MARKETING_PAGE_EVIDENCE_TYPES as readonly string[]
    ).includes(claim.type);

    if (needsPageEvidence) {
      if (claim.evidence?.kind !== "page") {
        context.addIssue({
          code: "custom",
          message: `a ${claim.type} claim's evidence is a string on one of our own pages`,
        });
        return;
      }
      if (claim.evidence.localeKey !== claim.statementKey) {
        context.addIssue({
          code: "custom",
          message:
            "the rendered claim is the evidence, so statementKey and the evidence key are one key",
        });
      }
      return;
    }

    if (claim.type === "comparison" && claim.evidence?.kind !== "external") {
      context.addIssue({
        code: "custom",
        message: "a comparison claim names where it was read",
      });
    }
  });

export type MarketingClaim = z.infer<typeof marketingClaimSchema>;

export const marketingClaimRegistrySchema = z.array(marketingClaimSchema);

/**
 * The registered claims.
 *
 * Empty, and not a placeholder: a claim is added by a person who has the
 * evidence in front of them, and S1 ships the shape and the resolver rather
 * than content nobody has checked. The Guard refuses a draft whose claim ids
 * are not here, so an empty registry means no claim-bearing copy publishes --
 * which is the correct state before anybody has approved one.
 */
export const MARKETING_CLAIMS: readonly MarketingClaim[] = [];

/** The registry version, which a post records so a later read knows what it saw. */
export const MARKETING_CLAIM_REGISTRY_VERSION = 1;

export const marketingClaimById = (
  id: string,
  registry: readonly MarketingClaim[] = MARKETING_CLAIMS,
): MarketingClaim | null => registry.find((claim) => claim.id === id) ?? null;

/** A claim with its evidence removed. This is what a generator is given. */
export type MarketingClaimProjection = Omit<MarketingClaim, "evidence">;

/**
 * The registry as the generator sees it (§2).
 *
 * The evidence is dropped rather than redacted: a field named `evidence` whose
 * value said "withheld" would still tell a model that evidence exists and what
 * shape it has, and the point is that generation happens without it.
 */
export function generatorProjection(
  registry: readonly MarketingClaim[] = MARKETING_CLAIMS,
): MarketingClaimProjection[] {
  return registry.map((claim) => {
    // Built by naming what the generator gets rather than by removing what it
    // does not. A destructuring rest would do the same thing today and would
    // silently forward any field added to a claim later, which is the opposite
    // of the rule this function exists for.
    const projection: MarketingClaimProjection = {
      id: claim.id,
      type: claim.type,
      statementKey: claim.statementKey,
      locales: claim.locales,
      validUntil: claim.validUntil,
      gate: claim.gate,
    };
    return projection;
  });
}

/** Why a claim cannot be used for a draft. */
export type MarketingClaimRefusal =
  | "unknown_claim"
  | "locale_not_covered"
  | "claim_expired"
  | "gate_unreadable"
  | "gate_off";

export type MarketingClaimResolution =
  | { ok: true; claim: MarketingClaim }
  | { ok: false; refusal: MarketingClaimRefusal };

/**
 * Whether a claim may be used, for a locale, on a date.
 *
 * `gateEnabled` is three-valued on purpose: a flag that cannot be read is not
 * the same as a flag that is off, but both refuse. Passing `null` for "could
 * not read" keeps the caller from turning an unreadable input into `false` and
 * losing which of the two happened.
 */
export function resolveMarketingClaim({
  id,
  locale,
  on,
  gateEnabled,
  registry = MARKETING_CLAIMS,
}: {
  id: string;
  locale: string;
  on: Date;
  gateEnabled?: boolean | null;
  registry?: readonly MarketingClaim[];
}): MarketingClaimResolution {
  const claim = marketingClaimById(id, registry);
  if (!claim) return { ok: false, refusal: "unknown_claim" };

  if (!(claim.locales as readonly string[]).includes(locale)) {
    return { ok: false, refusal: "locale_not_covered" };
  }

  // The last day is inclusive: a claim valid until the 30th is usable on the
  // 30th, which is what a person writing that date means.
  if (on.toISOString().slice(0, 10) > claim.validUntil) {
    return { ok: false, refusal: "claim_expired" };
  }

  if (claim.gate) {
    if (gateEnabled === null || gateEnabled === undefined) {
      return { ok: false, refusal: "gate_unreadable" };
    }
    if (!gateEnabled) return { ok: false, refusal: "gate_off" };
  }

  return { ok: true, claim };
}
