import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, mock, test } from "node:test";

// The GA4 deletion request is a follow-up to an account deletion, never part
// of it (marketing policy §10.2, §12.2): it runs after the transaction commits,
// it does not run when the transaction fails, and nothing it does -- not even
// throwing -- can turn a completed deletion into a failed one.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

const order: string[] = [];
let transactionFails = false;
let ga4Throws = false;

const anyTable = new Proxy(
  {},
  {
    get: () => async () => [],
  }
);
const tx = new Proxy({}, { get: () => anyTable });

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      user: {
        findUnique: async () => ({
          id: "cmh-deleted-account",
          email: "gone@example.test",
          stripeSubscriptionId: null,
        }),
      },
      $transaction: async (work: (client: unknown) => Promise<unknown>) => {
        order.push("transaction:start");
        await work(tx);
        if (transactionFails) throw new Error("serialization failure");
        order.push("transaction:commit");
      },
    },
  },
});
const noop = async () => {};
mock.module(mod("lib/accountDataAnonymisation.ts"), {
  namedExports: { anonymiseAccountData: noop },
});
mock.module(mod("lib/chatSecurity.ts"), {
  namedExports: { getUserChatUsageKey: (id: string) => `user:${id}` },
});
mock.module(mod("lib/imageAssetLifecycle.ts"), {
  namedExports: { enqueueImageAssetCleanupForConversations: noop },
});
mock.module(mod("lib/generatedArtifactStorage.ts"), {
  namedExports: { enqueueArtifactCleanupForUser: noop },
});
mock.module(mod("lib/messageAttachmentStorage.ts"), {
  namedExports: { enqueueMessageAttachmentCleanupForUser: noop },
});
mock.module(mod("lib/deepResearchJobs.ts"), {
  namedExports: { deleteDeepResearchJobsForConversations: noop },
});
mock.module(mod("lib/stripe.ts"), {
  namedExports: { getStripe: () => ({}), isStripeConfigured: () => false },
});
mock.module(mod("lib/mobileAuthService.ts"), {
  namedExports: { recordMobileSessionsEndedByDeletion: noop },
});
mock.module(mod("lib/auRelationship.ts"), {
  namedExports: { recordRelationshipEnded: noop },
});
mock.module(mod("lib/sessionSecurity.ts"), {
  namedExports: { revokeAllUserSessions: noop },
});
mock.module(mod("lib/supportTriageAccountDeletion.ts"), {
  namedExports: {
    deleteSupportTriageDataForAccount: async () => ({}),
    flushSupportTriageDeletionAudit: noop,
  },
});
mock.module(mod("lib/ga4UserDeletion.ts"), {
  namedExports: {
    requestGa4UserDeletionForAccount: async (userId: string) => {
      order.push(`ga4:${userId}`);
      if (ga4Throws) throw new Error("ga4 unreachable");
      return { status: "submitted", deletionRequestTime: null };
    },
  },
});

const deleteAccount = async () => {
  const { deleteTomverseAccount } = (await import(mod("lib/accountDeletion.ts"))) as {
    deleteTomverseAccount: (userId: string) => Promise<{ deleted: boolean }>;
  };
  return deleteTomverseAccount("cmh-deleted-account");
};

beforeEach(() => {
  order.length = 0;
  transactionFails = false;
  ga4Throws = false;
});

test("the GA4 request follows the committed deletion", async () => {
  const result = await deleteAccount();
  assert.equal(result.deleted, true);
  assert.deepEqual(order, [
    "transaction:start",
    "transaction:commit",
    "ga4:cmh-deleted-account",
  ]);
});

test("a GA4 failure cannot fail the deletion", async () => {
  ga4Throws = true;
  const result = await deleteAccount();
  assert.equal(result.deleted, true);
  assert.equal(order.at(-1), "ga4:cmh-deleted-account");
});

test("a deletion that did not commit never asks GA4 to delete anything", async () => {
  transactionFails = true;
  await assert.rejects(deleteAccount(), /serialization failure/);
  assert.ok(!order.some((step) => step.startsWith("ga4:")));
});
