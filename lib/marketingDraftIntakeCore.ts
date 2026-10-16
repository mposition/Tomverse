/**
 * The generator's draft submission (S3 plan, S3a): its shape, its provenance
 * and the key a draft is stored under. Pure -- no database, no environment.
 *
 * The generator is not trusted (docs/policy/marketing-automation.md §4): it
 * holds an LLM key and this route's secret and nothing else, and what it sends
 * is words plus the ids it chose. So the shape has no field for a verdict, a
 * status, a mode, a template, a link or a schedule -- the app's Guard decides
 * the first four, and S3 drafts are new copy, so there is no template to bind
 * and nothing to schedule. A field that is not in the schema is a refusal, not
 * something ignored.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { marketingEnvelopeSchema } from "@/lib/marketingAutomationSchema";

/** The largest body read; the route abandons the stream at the first byte over. */
export const MARKETING_DRAFT_INTAKE_MAX_BODY_BYTES = 64 * 1024;
/** Drafts per submission (docs/policy/marketing-automation.md §4). */
export const MARKETING_DRAFT_INTAKE_MAX_DRAFTS = 20;
/** Where a stored key says a draft came from. */
export const MARKETING_DRAFT_INTAKE_SOURCE = "marketing-generator";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const isoInstant = z.string().datetime({ offset: false });
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const envelope = marketingEnvelopeSchema.shape;

export const marketingGeneratorDraftSchema = z
  .object({
    logicalDraftId: id,
    kind: z.enum(["social", "rednote_package"]),
    channelId: id,
    locale: envelope.locale,
    renderedText: envelope.renderedText,
    claimIds: envelope.claimIds,
    assets: envelope.assets,
    disclosureFlags: envelope.disclosureFlags,
  })
  .strict();

export type MarketingGeneratorDraft = z.infer<typeof marketingGeneratorDraftSchema>;

export const marketingDraftSubmissionSchema = z
  .object({
    generatorRunId: id,
    submissionId: id,
    /**
     * When the service stops waiting. Signed with the rest, and enforced by the
     * database: a draft whose transaction could outlast it is not started, and
     * one that does is rolled back by its own `transaction_timeout`.
     */
    deadlineAt: isoInstant,
    drafts: z.array(marketingGeneratorDraftSchema).min(1).max(MARKETING_DRAFT_INTAKE_MAX_DRAFTS),
    provenance: hex64,
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const draft of value.drafts) {
      if (seen.has(draft.logicalDraftId)) {
        context.addIssue({
          code: "custom",
          message: "A submission names each draft once",
          path: ["drafts"],
        });
        return;
      }
      seen.add(draft.logicalDraftId);
    }
  });

export type MarketingDraftSubmission = z.infer<typeof marketingDraftSubmissionSchema>;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, inner]) => [key, canonical(inner)]),
    );
  }
  return value;
};

/** Keys sorted, so the generator and the app sign the same bytes. */
export const canonicalMarketingDraftJson = (value: unknown): string =>
  JSON.stringify(canonical(value));

/**
 * The provenance of a whole submission: HMAC-SHA256 under the submit secret
 * over everything in it but this field. Signing the drafts alone left the run
 * and submission ids free to be swapped onto someone else's words.
 */
export const marketingDraftProvenance = (
  secret: string,
  submission: Omit<MarketingDraftSubmission, "provenance">,
): string =>
  createHmac("sha256", secret)
    .update(
      canonicalMarketingDraftJson({
        domain: "marketing-draft-submission-v1",
        generatorRunId: submission.generatorRunId,
        submissionId: submission.submissionId,
        deadlineAt: submission.deadlineAt,
        drafts: submission.drafts,
      }),
      "utf8",
    )
    .digest("hex");

export const marketingDraftProvenanceMatches = (
  secret: string,
  submission: MarketingDraftSubmission,
): boolean => {
  const expected = Buffer.from(marketingDraftProvenance(secret, submission), "hex");
  const provided = Buffer.from(submission.provenance, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
};

/** Stored with the audit row: which signed submission a post came from, not the signature. */
export const marketingDraftProvenanceDigest = (provenance: string): string =>
  createHash("sha256").update(provenance, "utf8").digest("hex");

/**
 * The key a draft is stored under, derived here so the generator cannot name
 * another draft's key: the same run, submission and draft id are the same key,
 * and a resubmission finds the row the first one made.
 */
export const marketingGeneratorDraftLogicalKey = (input: {
  generatorRunId: string;
  submissionId: string;
  logicalDraftId: string;
}): string =>
  createHash("sha256")
    .update(
      canonicalMarketingDraftJson({
        source: MARKETING_DRAFT_INTAKE_SOURCE,
        generatorRunId: input.generatorRunId,
        submissionId: input.submissionId,
        logicalDraftId: input.logicalDraftId,
      }),
      "utf8",
    )
    .digest("hex");

/**
 * What one draft said, bound to where it came from: stored with the audit row
 * of its intake, so a resubmission under the same ids is the same draft only
 * if it says the same thing. Different words under the same key are a
 * conflict, not a second success.
 */
export const marketingGeneratorDraftIntakeDigest = (input: {
  generatorRunId: string;
  submissionId: string;
  draft: MarketingGeneratorDraft;
}): string =>
  createHash("sha256")
    .update(
      canonicalMarketingDraftJson({
        domain: "marketing-draft-intake-v1",
        generatorRunId: input.generatorRunId,
        submissionId: input.submissionId,
        draft: input.draft,
      }),
      "utf8",
    )
    .digest("hex");
