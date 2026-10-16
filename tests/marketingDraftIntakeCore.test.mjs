import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_DRAFT_INTAKE_MAX_DRAFTS,
  marketingDraftProvenance,
  marketingDraftProvenanceMatches,
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

const unsigned = (overrides = {}) => ({
  generatorRunId: "run-1",
  submissionId: "sub-1",
  deadlineAt: "2026-10-16T03:00:00.000Z",
  drafts: [draft()],
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
  ]) {
    assert.equal(marketingDraftProvenanceMatches(SECRET, { ...body, ...change }), false, JSON.stringify(change));
  }
  // Key order does not matter; the bytes signed are canonical.
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  assert.equal(marketingDraftProvenanceMatches(SECRET, reordered), true);
});

test("the stored key is derived from where a draft came from, and the digest from what it says", () => {
  const ids = { generatorRunId: "run-1", submissionId: "sub-1", logicalDraftId: "draft-1" };
  const key = marketingGeneratorDraftLogicalKey(ids);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(marketingGeneratorDraftLogicalKey(ids), key);
  assert.notEqual(marketingGeneratorDraftLogicalKey({ ...ids, logicalDraftId: "draft-2" }), key);
  assert.notEqual(marketingGeneratorDraftLogicalKey({ ...ids, generatorRunId: "run-2" }), key);

  const digest = marketingGeneratorDraftIntakeDigest({ generatorRunId: "run-1", submissionId: "sub-1", draft: draft() });
  assert.equal(
    marketingGeneratorDraftIntakeDigest({ generatorRunId: "run-1", submissionId: "sub-1", draft: draft() }),
    digest,
  );
  assert.notEqual(
    marketingGeneratorDraftIntakeDigest({
      generatorRunId: "run-1",
      submissionId: "sub-1",
      draft: draft({ renderedText: "Other words." }),
    }),
    digest,
  );
});
