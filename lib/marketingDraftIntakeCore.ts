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

// Relative, so the generator service can load this module with
// --experimental-strip-types and sign exactly what the intake verifies.
import { marketingEnvelopeSchema } from "./marketingAutomationSchema.ts";

/** The largest body read; the route abandons the stream at the first byte over. */
export const MARKETING_DRAFT_INTAKE_MAX_BODY_BYTES = 64 * 1024;
/** Drafts per submission (docs/policy/marketing-automation.md §4). */
export const MARKETING_DRAFT_INTAKE_MAX_DRAFTS = 20;
/** Where a stored key says a draft came from. */
export const MARKETING_DRAFT_INTAKE_SOURCE = "marketing-generator";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const isoInstant = z.string().datetime({ offset: false });
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const requestKey = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** The LLM calls one submission may name; each was reserved in the cost ledger. */
export const MARKETING_DRAFT_INTAKE_MAX_LLM_CALLS = 8;

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
     * database: a new draft whose transaction could outlast it is not started,
     * and no success is recorded after it. COMMIT's durable phase is not
     * bounded by it; a lost answer is read back by resubmitting the same key.
     */
    deadlineAt: isoInstant,
    drafts: z.array(marketingGeneratorDraftSchema).min(1).max(MARKETING_DRAFT_INTAKE_MAX_DRAFTS),
    /**
     * The cost-ledger calls that produced these drafts, by their request keys,
     * sorted and each once (S3c4). The intake consumes them for this
     * submission; a call can be consumed by one submission only.
     */
    llmCallRequestKeys: z.array(requestKey).min(1).max(MARKETING_DRAFT_INTAKE_MAX_LLM_CALLS),
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
    const keys = value.llmCallRequestKeys;
    if (keys.some((key, index) => index > 0 && keys[index - 1] >= key)) {
      context.addIssue({
        code: "custom",
        message: "LLM call keys are sorted and named once",
        path: ["llmCallRequestKeys"],
      });
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
 * The canonical bytes of a whole submission but its signature, v2 (S3c4): the
 * run and submission ids, the deadline, every draft in order and the LLM calls
 * it consumes. The signature, the submission digest, each draft's intake digest
 * and the ledger's consumer digest all rest on these same bytes, so none of
 * them can be swapped onto another submission's words or calls.
 */
const submissionBytes = (submission: Omit<MarketingDraftSubmission, "provenance">): string =>
  canonicalMarketingDraftJson({
    domain: "marketing-draft-submission-v2",
    generatorRunId: submission.generatorRunId,
    submissionId: submission.submissionId,
    deadlineAt: submission.deadlineAt,
    drafts: submission.drafts,
    llmCallRequestKeys: submission.llmCallRequestKeys,
  });

/** HMAC-SHA256 under the submit secret over the submission's canonical bytes. */
export const marketingDraftProvenance = (
  secret: string,
  submission: Omit<MarketingDraftSubmission, "provenance">,
): string => createHmac("sha256", secret).update(submissionBytes(submission), "utf8").digest("hex");

/** SHA-256 of the same bytes the signature covers. */
export const marketingDraftSubmissionDigest = (
  submission: Omit<MarketingDraftSubmission, "provenance">,
): string => createHash("sha256").update(submissionBytes(submission), "utf8").digest("hex");

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
 * One draft of one submission: stored with the audit row of its intake, so a
 * resubmission under the same key is the same draft only if it is the same
 * signed submission. A generator that lost its answer sends that submission
 * again, byte for byte -- the read-back comes before the deadline is checked --
 * and different words, calls or deadline under the same key are a conflict,
 * not a second success.
 */
export const marketingGeneratorDraftIntakeDigest = (input: {
  submissionDigest: string;
  logicalDraftId: string;
}): string =>
  createHash("sha256")
    .update(
      canonicalMarketingDraftJson({
        domain: "marketing-draft-intake-v2",
        submissionDigest: input.submissionDigest,
        logicalDraftId: input.logicalDraftId,
      }),
      "utf8",
    )
    .digest("hex");
