// Calls the schedule, unpublish, withdraw, record-manual and edit routes with the shared mutation
// wrapper and the store's writers stood in for, and prints, for each, the metadata the
// route hands the wrapper next to the metadata the store will require of that
// audit entry. Needs --experimental-test-module-mocks
// (tests/marketingPostAuditMetadataRoute.test.mjs).

import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = (path) => pathToFileURL(resolve(path)).href;

const real = await import(mod("lib/marketingStore.ts"));

let captured = null;
const storeCalls = [];

mock.module(mod("lib/marketingAdminMutations.ts"), {
  namedExports: {
    runMarketingAdminMutation: async (spec) => {
      captured = spec;
      return new Response(null, { status: 204 });
    },
  },
});

mock.module(mod("lib/marketingStore.ts"), {
  namedExports: {
    MARKETING_S2B1_ACTIONS: real.MARKETING_S2B1_ACTIONS,
    marketingScheduleAuditMetadata: real.marketingScheduleAuditMetadata,
    marketingEditAuditMetadata: real.marketingEditAuditMetadata,
    editMarketingPost: async (_tx, input) => {
      storeCalls.push(input);
    },
    marketingUnpublishAuditMetadata: real.marketingUnpublishAuditMetadata,
    MARKETING_POST_WITHDRAW_APPROVAL_ACTION: real.MARKETING_POST_WITHDRAW_APPROVAL_ACTION,
    MARKETING_POST_RECORD_MANUAL_ACTION: real.MARKETING_POST_RECORD_MANUAL_ACTION,
    MARKETING_MANUAL_PUBLISH_EVIDENCE_MAX: real.MARKETING_MANUAL_PUBLISH_EVIDENCE_MAX,
    MARKETING_MANUAL_PUBLISH_URL_MAX: real.MARKETING_MANUAL_PUBLISH_URL_MAX,
    MarketingManualPostRefusedError: real.MarketingManualPostRefusedError,
    marketingRecordManualPublishAuditMetadata: real.marketingRecordManualPublishAuditMetadata,
    recordManualMarketingPostPublication: async (_tx, input) => {
      storeCalls.push(input);
      return { slotDate: "2026-11-04", warnings: [] };
    },
    MarketingPostWithdrawRefusedError: real.MarketingPostWithdrawRefusedError,
    marketingWithdrawApprovalAuditMetadata: real.marketingWithdrawApprovalAuditMetadata,
    withdrawMarketingPostApproval: async (_tx, input) => {
      storeCalls.push(input);
    },
    scheduleMarketingPost: async (_tx, input) => {
      storeCalls.push(input);
    },
    unpublishMarketingPost: async (_tx, input) => {
      storeCalls.push(input);
    },
  },
});

const call = async (leaf, body, required) => {
  captured = null;
  storeCalls.length = 0;
  const { POST } = await import(mod(`app/api/admin/marketing/posts/[postId]/${leaf}/route.ts`));
  await POST(new Request(`https://tomverse.app/api/admin/marketing/posts/post-1/${leaf}`, { method: "POST" }), {
    params: Promise.resolve({ postId: "post-1" }),
  });
  await captured.run({}, { body, auditLogId: "audit-1", session: {} });
  return {
    action: captured.action,
    written: captured.metadata(body),
    required: required(storeCalls[0]),
  };
};

const digest = "a".repeat(64);

// The edit route's entry is built from the stored row, read in the transaction.
const storedEnvelope = {
  channel: "linkedin",
  accountSlug: "linkedin-1",
  locale: "en",
  renderedText: "The words the generator wrote.",
  claimIds: ["claim.models-compared"],
  assets: [{ assetId: "asset.hero", altKey: "alt.hero" }],
  finalUrl: "https://tomverse.app/",
  scheduledAt: "2026-09-18T01:00:00.000Z",
  disclosureFlags: ["advertising"],
};
const editTx = {
  marketingPost: {
    findUnique: async ({ where }) => (where.id === "post-1" ? { envelope: storedEnvelope } : null),
  },
};
const edit = async () => {
  captured = null;
  const { POST } = await import(mod("app/api/admin/marketing/posts/[postId]/edit/route.ts"));
  await POST(new Request("https://tomverse.app/api/admin/marketing/posts/post-1/edit", { method: "POST" }), {
    params: Promise.resolve({ postId: "post-1" }),
  });
  const body = { expectedEnvelopeDigest: digest, expectedHistoryVersion: 1, renderedText: "The words a person corrected." };
  return {
    action: captured.action,
    written: await captured.metadata(body, editTx),
    // What editMarketingPost requires: the stored envelope with the new words.
    required: real.marketingEditAuditMetadata({
      expectedEnvelopeDigest: digest,
      envelope: { ...storedEnvelope, renderedText: body.renderedText },
    }),
    storedDigest: real.marketingEnvelopeDigest(storedEnvelope),
  };
};
const results = {
  schedule: await call(
    "schedule",
    { expectedEnvelopeDigest: digest, expectedHistoryVersion: 3, scheduledAt: new Date("2026-11-03T07:15:00Z") },
    real.marketingScheduleAuditMetadata,
  ),
  unpublish: await call(
    "unpublish",
    {
      expectedStatus: "published",
      expectedHistoryVersion: 5,
      expectedExternalPostId: "ext-1",
      evidenceRef: "checked the profile",
      cancellationSupported: true,
      removalConfirmed: true,
    },
    real.marketingUnpublishAuditMetadata,
  ),
  withdraw: await call(
    "withdraw",
    { expectedEnvelopeDigest: digest, expectedHistoryVersion: 2 },
    real.marketingWithdrawApprovalAuditMetadata,
  ),
  edit: await edit(),
  recordManual: await call(
    "record-manual",
    {
      expectedEnvelopeDigest: digest,
      expectedHistoryVersion: 4,
      externalUrl: "https://x.com/tomverse/status/1",
      evidenceRef: "opened the link while signed out",
    },
    real.marketingRecordManualPublishAuditMetadata,
  ),
};

console.log(`MARKETING_POST_AUDIT_METADATA=${JSON.stringify(results)}`);
