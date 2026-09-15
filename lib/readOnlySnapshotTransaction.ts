import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Runs `work` inside one READ ONLY, REPEATABLE READ transaction.
 *
 * For reads whose parts must agree with each other: an authorisation decision
 * and the rows it authorises, or a file assembled from several queries. Under
 * PostgreSQL's REPEATABLE READ the snapshot is taken at the first statement
 * that is not transaction control -- so `SET TRANSACTION READ ONLY` runs first
 * and every read after it sees the same committed state. READ ONLY makes an
 * accidental write inside `work` an error (SQLSTATE 25006) rather than a
 * silent side effect of a read path.
 *
 * Keep `work` short: an open snapshot holds back vacuum for the rows it can
 * still see.
 */
export async function readOnlySnapshotTransaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { timeout: number; maxWait: number }
): Promise<T> {
    return prisma.$transaction(
        async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            return work(tx);
        },
        {
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
            timeout: options.timeout,
            maxWait: options.maxWait,
        }
    );
}
