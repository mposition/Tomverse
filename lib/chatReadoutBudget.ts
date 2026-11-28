import "server-only";

import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import {
  READOUT_PIECE_LEASE_SECONDS,
  type ReadoutBudgetStore,
  type ReadoutLeaseStore,
} from "@/lib/chatReadoutBudgetCore";

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
/** One account's piece `chunk` of one answer (lib/chatReadoutBudgetCore.ts, the lease). */
export const readoutPieceLeaseKey = (userId: string, messageId: string, chunk: number) =>
  hashed(`readout-piece:${userId}:${messageId}:${chunk}`);

/** Not a day or month period, so the maintenance sweep does not touch it; released rows are deleted. */
const LEASE_PERIOD = "readout-piece-lease";
const LEASE_PERIOD_START = new Date(0);

/**
 * The lease row is a bucket row: inserted, or taken over only when the
 * holder's lease has lapsed, by the same kind of conditional upsert as the
 * budgets, so two instances cannot both take it. Both sides of the lapse
 * comparison are the database clock.
 */
export const readoutLeaseStore: ReadoutLeaseStore = {
  async acquire(key) {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
      VALUES (${key}, ${LEASE_PERIOD}, ${LEASE_PERIOD_START}, 1, NOW())
      ON CONFLICT ("key", "period", "periodStart")
      DO UPDATE SET "count" = 1, "updatedAt" = NOW()
      WHERE "ChatUsageBucket"."updatedAt" < NOW() - (${READOUT_PIECE_LEASE_SECONDS}::int * INTERVAL '1 second')
      RETURNING "count"
    `;
    return rows.length > 0;
  },
  async release(key) {
    await prisma.$executeRaw`
      DELETE FROM "ChatUsageBucket"
      WHERE "key" = ${key} AND "period" = ${LEASE_PERIOD} AND "periodStart" = ${LEASE_PERIOD_START}
    `;
  },
};

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
