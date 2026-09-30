import "server-only";

import { prisma } from "@/lib/prisma";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import { revokeAllMobileSessions } from "@/lib/mobileAuthService";
import type {
    SessionSecuritySnapshotResult,
} from "@/lib/sessionRevocationCore";

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
    { expiresAt: number; snapshot: SessionSecuritySnapshotResult }
>();

const invalidateSnapshot = (userId: string) => {
    snapshotCache.delete(userId);
};

/**
 * Drops a user's cached snapshot. Callers that stamp `sessionsRevokedAt`
 * themselves -- lib/loginMethodsCore.ts does it inside its own transaction --
 * must call this, or the revocation is not observed until the TTL lapses.
 */
export const invalidateSessionSecuritySnapshot = invalidateSnapshot;

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
    // D11's widest revocation row: a forced sign-out reaches the mobile
    // families too. Without this the stamp above would stop the access tokens
    // and leave the refresh tokens working, so the next refresh would mint an
    // access token dated after the sign-out and the session would come back.
    await revokeAllMobileSessions({ userId, reason: "logout", now: revokedAt });
    invalidateSnapshot(userId);
    return revokedAt;
};

/**
 * Reads the server-side signals that decide whether a token is still valid.
 * Missing users and lookup failures are returned as explicit states so a JWT
 * cannot outlive its user record or be accepted when revocation cannot be
 * checked. Null is reserved for the isolated E2E database bypass.
 */
export const readSessionSecuritySnapshot = async (
    userId: string
): Promise<SessionSecuritySnapshotResult> => {
    // The Playwright server runs without a reachable database, so this lookup
    // would spend its connect timeout on every session resolution. Null is the
    // "leave the session alone" answer, which is what the fabricated E2E
    // session needs. isE2EDatabaseDisabled() additionally requires a loopback
    // NEXTAUTH_URL, so a real deployment cannot take this path.
    if (isE2EDatabaseDisabled()) return null;

    const cached = snapshotCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.snapshot;
    }

    let snapshot: SessionSecuritySnapshotResult;
    try {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { accountStatus: true, sessionsRevokedAt: true },
        });
        snapshot = user ?? { lookupStatus: "user-not-found" };
    } catch (error) {
        console.error("Session security snapshot lookup failed:", {
            errorName: error instanceof Error ? error.name : "UnknownError",
        });
        // Cache the miss briefly so an unreachable database does not trigger a
        // fresh connection attempt on every single request.
        snapshotCache.set(userId, {
            expiresAt: Date.now() + LOOKUP_FAILURE_TTL_MS,
            snapshot: { lookupStatus: "lookup-error" },
        });
        return { lookupStatus: "lookup-error" };
    }

    snapshotCache.set(userId, {
        expiresAt: Date.now() + SNAPSHOT_TTL_MS,
        snapshot,
    });
    return snapshot;
};
