import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
    resolveLeaseTtlSeconds,
    type ChatConcurrencyScope,
} from "@/lib/chatConcurrencyCore";

/**
 * Database side of the chat concurrency lease.
 *
 * Kept apart from lib/chatSecurity.ts so it can be used by the release,
 * heartbeat and reconciliation paths without importing the whole reservation
 * pipeline (and without a cycle through `ChatAccessError`). Nothing here
 * throws a user-facing error: callers translate the plain results.
 */

export type LeaseInsert = {
    id: string;
    subjectKey: string;
    /** Present for guests only; null for signed-in users. */
    ipKey: string | null;
    modelId: string | null;
    admissionId: string | null;
    /** Null for a slot reserved by preflight and not yet consumed. */
    claimedAt: Date | null;
    expiresAt: Date;
    /**
     * The per-minute request capacity this slot pre-paid, when it was reserved
     * by the aggregate comparison preflight. Both are null for an ordinary
     * single-request lease, which charges its own minute bucket inside its own
     * transaction and so has nothing to give back.
     *
     * `rateIpKey` is not `ipKey`: that one is the IP *concurrency* scope and is
     * populated for guests only, while the per-minute IP ceiling applies to
     * signed-in callers too.
     */
    rateIpKey?: string | null;
    rateMinuteStart?: Date | null;
};

type ReleasedSlot = {
    subjectKey: string;
    rateIpKey: string | null;
    rateMinuteStart: Date | null;
    claimedAt: Date | null;
};

/**
 * Gives back the per-minute request capacity of slots that never ran.
 *
 * Only ever called with rows this transaction has already deleted, so the
 * refund and the disappearance of the thing being refunded commit together:
 * the same slot cannot be credited twice, and a slot that survives is not
 * credited at all. A claimed slot is never passed in -- its request consumed
 * the capacity its slot reserved.
 *
 * The bucket is addressed by the minute the preflight actually charged, not by
 * the current minute, so a rollback arriving after the window rolled over
 * credits the row it debited instead of stealing from the new one.
 */
const refundRateReservations = async (
    tx: Prisma.TransactionClient,
    released: readonly ReleasedSlot[]
) => {
    const refunds = new Map<
        string,
        { key: string; periodStart: Date; amount: number }
    >();
    for (const slot of released) {
        if (!slot.rateMinuteStart) continue;
        // One slot pre-paid one unit in each scope it was charged in: the
        // caller's own bucket and, when the rate ceiling applied, the IP's.
        for (const key of [slot.subjectKey, slot.rateIpKey]) {
            if (!key) continue;
            const groupId = `${key}|${slot.rateMinuteStart.toISOString()}`;
            const existing = refunds.get(groupId);
            if (existing) existing.amount += 1;
            else {
                refunds.set(groupId, {
                    key,
                    periodStart: slot.rateMinuteStart,
                    amount: 1,
                });
            }
        }
    }
    for (const refund of refunds.values()) {
        await tx.$executeRaw`
            UPDATE "ChatUsageBucket"
            SET "count" = GREATEST("count" - ${refund.amount}::bigint, 0),
                "updatedAt" = NOW()
            WHERE "key" = ${refund.key}
              AND "period" = 'minute'
              AND "periodStart" = ${refund.periodStart}
        `;
    }
    return refunds.size;
};

/**
 * Removes rows whose expiry has passed for the scopes about to be counted.
 *
 * Expiry-based cleanup at read time is what keeps a crashed process from
 * holding a slot forever; the periodic sweep below only covers subjects that
 * never come back.
 *
 * An expired *unclaimed* admission slot also still holds the minute of request
 * rate its preflight pre-paid, so this hands that back at the same moment it
 * drops the slot. Without it a comparison the browser never sent would keep
 * both its concurrency slot and its rate unit until the minute rolled over,
 * which the next attempt from the same caller would run straight into.
 */
export const sweepExpiredLeasesForScopes = async (
    tx: Prisma.TransactionClient,
    keys: { subjectKey: string; ipKey?: string | null }
) => {
    const released = await tx.$queryRaw<ReleasedSlot[]>`
        DELETE FROM "ChatRequestLease"
        WHERE "expiresAt" <= NOW()
          AND ("subjectKey" = ${keys.subjectKey}
               OR ("ipKey" IS NOT NULL AND "ipKey" = ${keys.ipKey ?? null}))
        RETURNING "subjectKey", "rateIpKey", "rateMinuteStart", "claimedAt"
    `;
    await refundRateReservations(
        tx,
        released.filter((slot) => !slot.claimedAt)
    );
};

export const countActiveLeases = async (
    tx: Prisma.TransactionClient,
    scope: ChatConcurrencyScope
) => {
    const rows =
        scope.scope === "ip"
            ? await tx.$queryRaw<Array<{ count: bigint }>>`
                  SELECT COUNT(*)::bigint AS "count"
                  FROM "ChatRequestLease"
                  WHERE "ipKey" = ${scope.key} AND "expiresAt" > NOW()
              `
            : await tx.$queryRaw<Array<{ count: bigint }>>`
                  SELECT COUNT(*)::bigint AS "count"
                  FROM "ChatRequestLease"
                  WHERE "subjectKey" = ${scope.key} AND "expiresAt" > NOW()
              `;
    return Number(rows[0]?.count || 0);
};

export const insertLeases = async (
    tx: Prisma.TransactionClient,
    leases: LeaseInsert[]
) => {
    for (const lease of leases) {
        await tx.$executeRaw`
            INSERT INTO "ChatRequestLease"
                ("id", "subjectKey", "ipKey", "admissionId", "modelId",
                 "claimedAt", "heartbeatAt", "expiresAt", "createdAt",
                 "rateIpKey", "rateMinuteStart")
            VALUES (${lease.id}, ${lease.subjectKey}, ${lease.ipKey},
                    ${lease.admissionId}, ${lease.modelId}, ${lease.claimedAt},
                    NOW(), ${lease.expiresAt}, NOW(),
                    ${lease.rateIpKey ?? null}, ${lease.rateMinuteStart ?? null})
        `;
    }
};

/**
 * Consumes one pre-reserved admission slot.
 *
 * The conditional UPDATE is the whole replay defence: the row must still exist,
 * still belong to this admission *and* this subject, still be unclaimed, and
 * still be unexpired. A token replayed inside its lifetime finds `claimedAt`
 * already set and claims nothing, so a valid signature can never yield a second
 * slot.
 */
export const claimAdmissionSlot = async (
    tx: Prisma.TransactionClient,
    slot: {
        leaseId: string;
        admissionId: string;
        subjectKey: string;
        modelId: string;
    },
    ttlSeconds = resolveLeaseTtlSeconds()
) => {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const claimed = await tx.$executeRaw`
        UPDATE "ChatRequestLease"
        SET "claimedAt" = NOW(),
            "heartbeatAt" = NOW(),
            "expiresAt" = ${expiresAt}
        WHERE "id" = ${slot.leaseId}
          AND "admissionId" = ${slot.admissionId}
          AND "subjectKey" = ${slot.subjectKey}
          AND "modelId" = ${slot.modelId}
          AND "claimedAt" IS NULL
          AND "expiresAt" > NOW()
    `;
    return claimed === 1;
};

/**
 * Renews a running stream's lease.
 *
 * Returns false when the lease is already gone (released, swept, or taken over
 * by the deep-research handoff), which the caller uses to stop heartbeating
 * rather than resurrecting a slot nothing owns.
 */
export const touchChatRequestLease = async (
    leaseId: string,
    ttlSeconds = resolveLeaseTtlSeconds()
) => {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const updated = await prisma.$executeRaw`
        UPDATE "ChatRequestLease"
        SET "heartbeatAt" = NOW(), "expiresAt" = ${expiresAt}
        WHERE "id" = ${leaseId}
    `;
    return updated === 1;
};

const RELEASE_RETRY_DELAYS_MS = [50, 250];

const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deletes one lease. Idempotent: releasing an already-released lease succeeds.
 *
 * A failure here used to disappear into `console.error`, which is how a slot
 * could be held by a request that had already finished with nothing to show
 * for it. Now the last failure is retried, then recorded as a structured
 * operational event with the lease's own scope so the orphan is attributable,
 * and the periodic sweep below is the backstop that actually frees it.
 */
export const releaseChatRequestLease = async (
    leaseId: string,
    context?: {
        traceId?: string;
        reason?: string;
        subjectScope?: string;
    }
) => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= RELEASE_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            await prisma.$executeRaw`
                DELETE FROM "ChatRequestLease" WHERE "id" = ${leaseId}
            `;
            return true;
        } catch (error) {
            lastError = error;
            const delay = RELEASE_RETRY_DELAYS_MS[attempt];
            if (delay === undefined) break;
            await wait(delay);
        }
    }

    console.error(
        JSON.stringify({
            event: "chat_lease_release_failed",
            traceId: context?.traceId ?? null,
            reason: context?.reason ?? "unknown",
            leaseScope: context?.subjectScope ?? null,
            errorName:
                lastError instanceof Error ? lastError.name : "UnknownError",
            timestamp: new Date().toISOString(),
        })
    );
    await reportOperationalIncident({
        code: "chat_lease_release_failed",
        title: "A chat concurrency lease could not be released",
        error: lastError,
        severity: "warning",
        context: {
            traceId: context?.traceId,
            reason: context?.reason,
            leaseScope: context?.subjectScope,
        },
    }).catch(() => undefined);
    return false;
};

/**
 * Drops every slot of an admission that was never consumed, and hands back the
 * per-minute request capacity those slots pre-paid.
 *
 * Called when a comparison fails between "slots reserved" and "requests sent",
 * so an aborted run gives its allowance back immediately instead of after a
 * TTL. Claimed slots are left alone -- those belong to requests that are
 * genuinely running, that consumed the capacity their slot reserved, and that
 * release themselves.
 *
 * One statement, so the refund can neither be applied to a slot that is still
 * there nor applied twice: a slot is deleted and its unit given back in the
 * same transaction, and a second call finds nothing left to delete. The refund
 * names the exact minute bucket the preflight charged (`rateMinuteStart`), so
 * a rollback arriving after the minute has rolled over credits the bucket it
 * actually debited rather than the current one, and `GREATEST(..., 0)` keeps a
 * counter that was reset underneath us from going negative.
 */
export const releaseUnclaimedAdmission = async (
    admissionId: string,
    context?: { traceId?: string }
) => {
    try {
        return await prisma.$transaction(async (tx) => {
            const released = await tx.$queryRaw<ReleasedSlot[]>`
                DELETE FROM "ChatRequestLease"
                WHERE "admissionId" = ${admissionId} AND "claimedAt" IS NULL
                RETURNING "subjectKey", "rateIpKey", "rateMinuteStart",
                          "claimedAt"
            `;
            await refundRateReservations(tx, released);
            return released.length;
        });
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "chat_admission_rollback_failed",
                traceId: context?.traceId ?? null,
                errorName: error instanceof Error ? error.name : "UnknownError",
                timestamp: new Date().toISOString(),
            })
        );
        return 0;
    }
};

/**
 * Periodic sweep for leases nothing came back to release.
 *
 * Every release path is best-effort by nature -- a process can be killed
 * mid-stream, and a database write can fail after the response has already
 * ended. Expiry makes those slots harmless, but only this sweep makes them
 * *gone*, which is what keeps the row count (and therefore the concurrency
 * count) honest over a long-running deployment.
 *
 * Deliberately does not refund per-minute rate capacity, unlike the read-time
 * sweep above. It runs every fifteen minutes, by which point the minute bucket
 * a slot charged has long since been replaced by a new one, so there is
 * nothing left to give back; the read-time sweep is what catches an abandoned
 * admission while its minute is still current.
 */
export const reconcileExpiredChatRequestLeases = async (
    now = new Date(),
    maximum = 5_000
) => {
    const limit = Math.min(50_000, Math.max(1, maximum));
    const deleted = await prisma.$executeRaw`
        DELETE FROM "ChatRequestLease"
        WHERE "id" IN (
            SELECT "id" FROM "ChatRequestLease"
            WHERE "expiresAt" <= ${now}
            ORDER BY "expiresAt" ASC
            LIMIT ${limit}
        )
    `;
    if (deleted > 0) {
        console.info(
            JSON.stringify({
                event: "chat_lease_reconciliation",
                orphanedLeasesRemoved: deleted,
                timestamp: now.toISOString(),
            })
        );
    }
    return { removed: deleted };
};
