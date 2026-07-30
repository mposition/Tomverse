import "server-only";

import { prisma } from "@/lib/prisma";
import type { SessionSecuritySnapshot } from "@/lib/sessionRevocationCore";

/**
 * Short-lived cache so resolving a session does not hit the database on every
 * request. The TTL bounds how long a revoked token can still be accepted; keep
 * it small enough that incident response stays effective.
 */
const SNAPSHOT_TTL_MS = 15_000;

/** Backoff after a failed lookup, so an unreachable database is not retried per request. */
const LOOKUP_FAILURE_TTL_MS = 5_000;

const snapshotCache = new Map<
    string,
    { expiresAt: number; snapshot: SessionSecuritySnapshot | null }
>();

const invalidateSnapshot = (userId: string) => {
    snapshotCache.delete(userId);
};

/**
 * Revokes every session belonging to a user.
 *
 * Sessions use the JWT strategy, so there is nothing to delete server-side.
 * Bumping `sessionsRevokedAt` invalidates every token issued at or before now;
 * the check runs in the NextAuth callbacks on each session resolution. The
 * `Session` table is also cleared so the control stays correct if the project
 * ever switches to `session.strategy = "database"`.
 */
export const revokeAllUserSessions = async (userId: string) => {
    const revokedAt = new Date();
    await prisma.user.update({
        where: { id: userId },
        data: { sessionsRevokedAt: revokedAt },
    });
    await prisma.session.deleteMany({ where: { userId } });
    invalidateSnapshot(userId);
    return revokedAt;
};

/**
 * Reads the server-side signals that decide whether a token is still valid.
 * Returns null when the user no longer exists or the lookup fails, which callers
 * treat as "do not change the session" rather than "sign everyone out".
 */
export const readSessionSecuritySnapshot = async (
    userId: string
): Promise<SessionSecuritySnapshot | null> => {
    const cached = snapshotCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.snapshot;
    }

    let snapshot: SessionSecuritySnapshot | null = null;
    try {
        snapshot = await prisma.user.findUnique({
            where: { id: userId },
            select: { accountStatus: true, sessionsRevokedAt: true },
        });
    } catch (error) {
        console.error("Session security snapshot lookup failed:", {
            errorName: error instanceof Error ? error.name : "UnknownError",
        });
        // Cache the miss briefly so an unreachable database does not trigger a
        // fresh connection attempt on every single request.
        snapshotCache.set(userId, {
            expiresAt: Date.now() + LOOKUP_FAILURE_TTL_MS,
            snapshot: null,
        });
        return null;
    }

    snapshotCache.set(userId, {
        expiresAt: Date.now() + SNAPSHOT_TTL_MS,
        snapshot,
    });
    return snapshot;
};
