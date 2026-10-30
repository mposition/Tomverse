import assert from "node:assert/strict";
import test from "node:test";

import { createHash } from "node:crypto";

import {
  MARKETING_DRAFT_INTAKE_MAX_DRAFTS,
  MARKETING_DRAFT_INTAKE_MAX_LLM_CALLS,
  canonicalMarketingDraftJson,
  marketingDraftProvenance,
  marketingDraftProvenanceMatches,
  marketingDraftSubmissionDigest,
  marketingDraftSubmissionSchema,
  marketingGeneratorDraftIntakeDigest,
  marketingGeneratorDraftLogicalKey,
} from "../lib/marketingDraftIntakeCore.ts";

const SECRET = "s".repeat(40);

const draft = (overrides = {}) => ({
  logicalDraftId: "draft-1",
  kind: "social",
  channelId: "chn_1",
  locale: "en",
  renderedText: "Three models, three answers, side by side.",
  claimIds: [],
  assets: [],
  disclosureFlags: ["advertising"],
  ...overrides,
});

const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const unsigned = (overrides = {}) => ({
  generatorRunId: "run-1",
  submissionId: "sub-1",
  deadlineAt: "2026-10-16T03:00:00.000Z",
  drafts: [draft()],
  llmCallRequestKeys: [key(1)],
  ...overrides,
});

const signed = (overrides = {}) => {
  const body = unsigned(overrides);
  return { ...body, provenance: marketingDraftProvenance(SECRET, body) };
};

test("a submission carries words and ids, never a verdict, a status, a template or a link", () => {
  assert.ok(marketingDraftSubmissionSchema.safeParse(signed()).success);
  for (const extra of [
    { verdict: "autonomous_eligible" },
    { status: "pending_approval" },
    { mode: "autonomous" },
    { templateId: "tpl_1" },
    { finalUrl: "https://tomverse.app/" },
    { scheduledAt: "2026-10-16T03:00:00.000Z" },
  ]) {
    const body = signed({ drafts: [draft(extra)] });
    assert.equal(marketingDraftSubmissionSchema.safeParse(body).success, false, JSON.stringify(extra));
  }
  assert.equal(marketingDraftSubmissionSchema.safeParse({ ...signed(), decision: "x" }).success, false);
});

test("a draft that does not say it is advertising is refused: every Tomverse post is one (S3i)", () => {
  for (const disclosureFlags of [[], ["ai_generated_asset"]]) {
    const body = signed({ drafts: [draft({ disclosureFlags })] });
    assert.equal(marketingDraftSubmissionSchema.safeParse(body).success, false, JSON.stringify(disclosureFlags));
  }
  const both = signed({ drafts: [draft({ disclosureFlags: ["advertising", "ai_generated_asset"] })] });
  assert.equal(marketingDraftSubmissionSchema.safeParse(both).success, true);
});

test("a submission is bounded and names each draft once", () => {
  const many = Array.from({ length: MARKETING_DRAFT_INTAKE_MAX_DRAFTS + 1 }, (_, index) =>
    draft({ logicalDraftId: `d${index}` }),
  );
  assert.equal(marketingDraftSubmissionSchema.safeParse(signed({ drafts: many })).success, false);
  assert.equal(marketingDraftSubmissionSchema.safeParse(signed({ drafts: [] })).success, false);
  assert.equal(
    marketingDraftSubmissionSchema.safeParse(signed({ drafts: [draft(), draft()] })).success,
    false,
  );
  assert.equal(
    marketingDraftSubmissionSchema.safeParse(signed({ deadlineAt: "tomorrow" })).success,
    false,
  );
});

test("the provenance signs the whole submission, deadline and ids included", () => {
  const body = signed();
  assert.equal(marketingDraftProvenanceMatches(SECRET, body), true);
  assert.equal(marketingDraftProvenanceMatches("t".repeat(40), body), false);
  for (const change of [
    { generatorRunId: "run-2" },
    { submissionId: "sub-2" },
    { deadlineAt: "2026-10-16T04:00:00.000Z" },
    { drafts: [draft({ renderedText: "Different words." })] },
    { llmCallRequestKeys: [key(2)] },
  ]) {
    assert.equal(marketingDraftProvenanceMatches(SECRET, { ...body, ...change }), false, JSON.stringify(change));
  }
  // Key order does not matter; the bytes signed are canonical.
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  assert.equal(marketingDraftProvenanceMatches(SECRET, reordered), true);
});

test("a submission names its LLM calls: one to eight, sorted, each once", () => {
  assert.ok(marketingDraftSubmissionSchema.safeParse(signed({ llmCallRequestKeys: [key(1), key(2)] })).success);
  for (const keys of [
    [],
    [key(2), key(1)],
    [key(1), key(1)],
    ["00000000-0000-4000-8000-00000000000A"],
    Array.from({ length: MARKETING_DRAFT_INTAKE_MAX_LLM_CALLS + 1 }, (_, index) => key(index + 1)),
  ]) {
    assert.equal(marketingDraftSubmissionSchema.safeParse(signed({ llmCallRequestKeys: keys })).success, false, JSON.stringify(keys));
  }
  assert.equal(marketingDraftSubmissionSchema.safeParse({ ...signed(), llmCallRequestKeys: undefined }).success, false);
});

test("the signature, the submission digest and the intake digest rest on the same canonical bytes", () => {
  const body = unsigned();
  const bytes = canonicalMarketingDraftJson({ domain: "marketing-draft-submission-v2", ...body });
  assert.equal(marketingDraftSubmissionDigest(body), createHash("sha256").update(bytes, "utf8").digest("hex"));
  // The signed body's own provenance is not part of what is digested.
  assert.equal(marketingDraftSubmissionDigest(signed()), marketingDraftSubmissionDigest(body));
  const digest = marketingDraftSubmissionDigest(body);
  assert.notEqual(marketingDraftSubmissionDigest({ ...body, deadlineAt: "2026-10-16T03:00:01.000Z" }), digest);
  assert.notEqual(marketingDraftSubmissionDigest({ ...body, llmCallRequestKeys: [key(2)] }), digest);
});

test("the stored key is derived from where a draft came from, and the digest from what it says", () => {
  const ids = { generatorRunId: "run-1", submissionId: "sub-1", logicalDraftId: "draft-1" };
  const key = marketingGeneratorDraftLogicalKey(ids);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(marketingGeneratorDraftLogicalKey(ids), key);
  assert.notEqual(marketingGeneratorDraftLogicalKey({ ...ids, logicalDraftId: "draft-2" }), key);
  assert.notEqual(marketingGeneratorDraftLogicalKey({ ...ids, generatorRunId: "run-2" }), key);

  const submissionDigest = marketingDraftSubmissionDigest(unsigned());
  const digest = marketingGeneratorDraftIntakeDigest({ submissionDigest, logicalDraftId: "draft-1" });
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(marketingGeneratorDraftIntakeDigest({ submissionDigest, logicalDraftId: "draft-1" }), digest);
  assert.notEqual(marketingGeneratorDraftIntakeDigest({ submissionDigest, logicalDraftId: "draft-2" }), digest);
  assert.notEqual(
    marketingGeneratorDraftIntakeDigest({
      submissionDigest: marketingDraftSubmissionDigest(unsigned({ drafts: [draft({ renderedText: "Other words." })] })),
      logicalDraftId: "draft-1",
    }),
    digest,
  );
});
