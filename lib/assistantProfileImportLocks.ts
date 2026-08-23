import "server-only";

import type { Prisma } from "@prisma/client";

/**
 * The two advisory locks the import paths take, and the order they take them in.
 *
 * docs/policy/assistant-package-import.md §5.6.
 *
 * ## Why a lock rather than a unique index
 *
 * What has to be serialised here is a *decision*, not a row. "Is there an
 * active staging import on this profile" and "does this account have room for
 * another file" are both answered by reading and then writing, and two
 * requests that read the same answer both pass. A unique index can stop two
 * identical rows; it cannot stop two different rows that were each only valid
 * while the other did not exist.
 *
 * ## The order is part of the contract
 *
 * A path that needs both takes the profile lock first and the account lock
 * second, always. Two paths taking them in opposite orders deadlock, and the
 * failure looks like an intermittent timeout on an unrelated request. Written
 * here rather than left to each call site, because a rule that lives in six
 * places is a rule five of them can get wrong.
 *
 * `pg_advisory_xact_lock` releases when the transaction ends, including when
 * it rolls back -- which is why these must only ever be called inside one.
 */

type TransactionClient = Prisma.TransactionClient;

/**
 * Serialises everything that changes what an import or a publish sees about
 * one profile.
 *
 * Held by: import creation, staging a file into it, cancelling, expiry
 * cleanup, the import's publish, and the ordinary editor's publish. That last
 * one is the point -- without it, an ordinary publish and an import publish
 * can both decide the profile is theirs to change.
 */
export async function lockProfileImport(
    tx: TransactionClient,
    profileId: string
): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-profile-import:${profileId}`}))`;
}

/**
 * Serialises the account-wide knowledge quota.
 *
 * The ceilings it protects are counted across every profile, so the profile
 * lock above does not help: two uploads into two different profiles of the
 * same account read the same totals and both pass. Taken second, after the
 * profile lock, whenever a path needs both.
 */
export async function lockAccountKnowledgeQuota(
    tx: TransactionClient,
    userId: string
): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-knowledge-quota:${userId}`}))`;
}
