import "server-only";

import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import { prisma } from "@/lib/prisma";

/**
 * Why a chat turn carried no imported excerpt, counted and logged.
 *
 * Policy: docs/policy/external-conversation-continuation.md §12.
 *
 * ## Why this exists at all
 *
 * §5 says the four ways a seed can be absent collapse to one return value, so
 * no caller can handle three of them and forget the fourth. That is a rule
 * about **control flow**, and it was mistaken for a rule about observation: the
 * loader returned `null` and recorded nothing, which left the staging
 * checklist's C-3 — "re-lock the source, confirm the turn is refused for
 * `locked`" — impossible to complete. There was no place the answer could be
 * read.
 *
 * So the two are separated here. The caller still gets one shape and still
 * cannot branch on why; the reason travels beside it, for a day counter and
 * one structured line, and for nothing else.
 *
 * ## What is never recorded
 *
 * No conversation id, no snapshot id, no digest, no ordinal, no imported text.
 * The reason is a fixed enum and the counter is a daily total, so the whole
 * record is "N turns went unseeded for reason R today" — content-free by
 * construction rather than by redaction.
 */

export const CONTINUATION_SEED_OUTCOMES = [
    /** A bridge was found, unlocked and non-empty: the excerpt was carried. */
    "seeded",
    /** The rollout flag is off. The rollback path, and the commonest reason. */
    "flag_off",
    /**
     * The flag was off in the database but on in *this process's* snapshot
     * cache, and the seed loader's re-read caught it.
     *
     * Its own outcome rather than a second way to say `flag_off`, because the
     * two answer different questions. `flag_off` says the rollback is holding
     * where it was made; this one says it reached an instance that had not
     * heard about it yet, which is the only evidence that the cross-instance
     * half of the rollback works at all. An operator watching a rollback wants
     * to see this go non-zero and then return to zero.
     */
    "flag_off_stale_cache",
    /** An ordinary conversation. Not a refusal; the denominator's other half. */
    "no_bridge",
    /** The imported original was deleted, so the foreign key is NULL. */
    "source_deleted",
    /** The snapshot is locked and this request holds no grant for it. */
    "locked",
    /**
     * A bridge and a readable source, but nothing survived the role filter or
     * the budget. Distinct from the three above: the source is reachable and
     * the excerpt is genuinely empty, which is a seed-rule question rather
     * than an access one.
     */
    "empty_selection",
] as const;

export type ContinuationSeedOutcome =
    (typeof CONTINUATION_SEED_OUTCOMES)[number];

const COUNTER_PERIOD = "continuation-day";

const counterKey = (outcome: ContinuationSeedOutcome) =>
    `continuation:seed-${outcome.replaceAll("_", "-")}`;

const dayStartUtc = (date: Date) =>
    new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    );

/**
 * One structured line per turn that could have been seeded and was not.
 *
 * `seeded` and `no_bridge` are counted but not logged: the first is the normal
 * path and the second is every other conversation in the product, so logging
 * either would bury the three lines an operator is actually looking for. This
 * is the same judgement `billing_price_catalog_fallback` makes — a line on the
 * healthy path drowns the signal it exists to carry.
 */
const LOGGED_OUTCOMES: ReadonlySet<ContinuationSeedOutcome> = new Set([
    "flag_off",
    "flag_off_stale_cache",
    "source_deleted",
    "locked",
    "empty_selection",
]);

/**
 * Fire-and-forget day counter, plus the line C-3 reads.
 *
 * Every error is swallowed after one log: recording an observation must never
 * become a second user-visible failure on a turn that is otherwise answering
 * normally. Same convention as `recordMemoryCounter`.
 */
export async function recordContinuationSeedOutcome(
    outcome: ContinuationSeedOutcome,
    now = new Date()
) {
    if (LOGGED_OUTCOMES.has(outcome)) {
        console.info(
            JSON.stringify({
                event: "continuation_seed_skipped",
                reason: outcome,
                // Stated so nobody reading the line has to work out whether the
                // user lost their turn: they did not. A turn with no excerpt is
                // an ordinary turn.
                served: "turn_without_excerpt",
            })
        );
    }
    try {
        await prisma.chatUsageBucket.upsert({
            where: {
                key_period_periodStart: {
                    key: counterKey(outcome),
                    period: COUNTER_PERIOD,
                    periodStart: dayStartUtc(now),
                },
            },
            create: {
                key: counterKey(outcome),
                period: COUNTER_PERIOD,
                periodStart: dayStartUtc(now),
                count: 1,
            },
            update: { count: { increment: 1 } },
        });
    } catch (error) {
        if (isMissingDatabaseSchemaError(error)) return;
        console.warn(
            JSON.stringify({
                event: "continuation_seed_counter_failed",
                reason: outcome,
            })
        );
    }
}
