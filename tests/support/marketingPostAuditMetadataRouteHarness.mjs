// Calls the schedule and unpublish routes with the shared mutation wrapper and
// the store's writers stood in for, and prints, for each, the metadata the
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
    marketingUnpublishAuditMetadata: real.marketingUnpublishAuditMetadata,
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
};

console.log(`MARKETING_POST_AUDIT_METADATA=${JSON.stringify(results)}`);
