import "server-only";

import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import type { ReadoutBudgetStore } from "@/lib/chatReadoutBudgetCore";

/**
 * The database store for the read-aloud guardrail (lib/chatReadoutBudgetCore.ts).
 *
 * The same `ChatUsageBucket` rows and the same conditional upsert as voice
 * input's budgets (lib/voiceInputBudget.ts, lib/voiceProviderBudgetLedger.ts):
 * the row is only updated while it still has room, so two instances cannot
 * both take the last of it. Its own periods (`readout-*`) and keys, so neither
 * budget can spend the other's.
 */

const secret = () => {
  const value = process.env.NEXTAUTH_SECRET;
  if (!value) throw new Error("NEXTAUTH_SECRET is not configured.");
  return value;
};

const hashed = (material: string) =>
  `readout:${createHash("sha256").update(`${material}:${secret()}`).digest("hex")}`;

/** Hashed, like every bucket key: a row must not name the account it counts. */
export const readoutAccountKey = (userId: string) => hashed(`readout-account-chars:${userId}`);
export const readoutProviderKey = () => hashed("readout-provider-chars");

export const readoutBudgetStore: ReadoutBudgetStore = {
  async book({ key, period, periodStart, characters, limit }) {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
      VALUES (${key}, ${period}, ${periodStart}, ${characters}, NOW())
      ON CONFLICT ("key", "period", "periodStart")
      DO UPDATE SET
        "count" = "ChatUsageBucket"."count" + ${characters},
        "updatedAt" = NOW()
      WHERE "ChatUsageBucket"."count" <= ${limit - characters}
      RETURNING "count"
    `;
    return rows.length > 0;
  },
  async unbook({ key, period, periodStart, characters }) {
    await prisma.$executeRaw`
      UPDATE "ChatUsageBucket"
      SET "count" = GREATEST("count" - ${characters}, 0), "updatedAt" = NOW()
      WHERE "key" = ${key}
        AND "period" = ${period}
        AND "periodStart" = ${periodStart}
    `;
  },
};
