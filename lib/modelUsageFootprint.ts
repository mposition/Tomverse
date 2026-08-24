import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * How many accounts have a model stored, across the three places a choice
 * lives.
 *
 * The number exists to answer one question at the moment a model is disabled:
 * does anybody have to be told? An automatic disable with nobody holding the
 * model is a catalogue correction; the same disable with two thousand accounts
 * pointing at it is a retirement that owes those accounts a notice, and the two
 * should not arrive in the queue looking alike (ML-08).
 *
 * The three places are the three the reconciliation script rewrites, and they
 * are counted the same way it selects them:
 * scripts/run-default-model-reconciliation.mjs.
 *
 * Contract: docs/policy/default-model-luna-migration.md §1.2.
 */

export type StoredModelUsage = {
  /** Accounts whose `UserSettings.defaultModel` is this model. */
  defaultModelAccounts: number;
  /** Accounts whose stored new-conversation combination contains it. */
  newConversationAccounts: number;
  /** Accounts with at least one conversation that selected it. */
  conversationAccounts: number;
  /** Distinct accounts across all three. Never larger than their sum. */
  distinctAccounts: number;
};

/**
 * `"id"` with the quotes, so the match is against a JSON array element rather
 * than a substring of one.
 *
 * Without them `gpt-5-4` matches `gpt-5-4-mini`, and a count that silently
 * includes the successor of the model being retired is worse than no count:
 * it would say a notice is owed to accounts that were never affected.
 */
const jsonElementPattern = (modelId: string) => `%"${modelId}"%`;

export async function countStoredModelUsage(
  modelId: string
): Promise<StoredModelUsage> {
  const pattern = jsonElementPattern(modelId);

  const [defaultModelAccounts, newConversationAccounts, conversationUsers, distinct] =
    await Promise.all([
      prisma.userSettings.count({ where: { defaultModel: modelId } }),
      prisma.userSettings.count({
        where: { newConversationModelIds: { array_contains: modelId } },
      }),
      prisma.conversation.findMany({
        where: { selectedModels: { contains: `"${modelId}"` } },
        select: { userId: true },
        distinct: ["userId"],
      }),
      // One statement rather than three id lists unioned in memory: the answer
      // is a single number and the sets can be large.
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM (
          SELECT "userId" FROM "UserSettings" WHERE "defaultModel" = ${modelId}
          UNION
          SELECT "userId" FROM "UserSettings"
           WHERE "newConversationModelIds"::text LIKE ${pattern}
          UNION
          SELECT "userId" FROM "Conversation" WHERE "selectedModels" LIKE ${pattern}
        ) AS affected
      `,
    ]);

  return {
    defaultModelAccounts,
    newConversationAccounts,
    conversationAccounts: conversationUsers.length,
    distinctAccounts: Number(distinct[0]?.count ?? 0),
  };
}
