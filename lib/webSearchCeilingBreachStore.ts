import "server-only";

/**
 * The durable half of the native-search ceiling latch.
 *
 * ## Why this exists
 *
 * When a provider bills more searches than the request authorized, the
 * capability stops dispatching. That decision was correct from the start; what
 * was missing was that it only held inside the process that saw the overshoot.
 * The comment in `webSearchNativeCostReservation.ts` said so, and called the
 * durable stop "disabling the model or the feature" -- an operator action that
 * nothing prompted and nobody had done.
 *
 * On 2026-08-26 the latch fired for real, on staging, and made the gap
 * concrete: the next deploy would have cleared it with no trace, and the
 * capability would have resumed overshooting. A guard whose lifetime is "until
 * the next deploy" reads as protection and is not.
 *
 * ## Shape
 *
 * One `AppSetting` row per breached provider. `AppSetting` is a key/value
 * table with an `updatedAt`, which is exactly the three facts worth keeping:
 * that it happened, to whom, and when. It is not a log -- a second breach for
 * the same provider updates the row rather than adding to it, because the
 * question this answers is "is this provider latched?" and the incident
 * history lives in Sentry.
 *
 * The refresh is cached rather than read per request: a latched provider stays
 * latched, and one row per chat turn buys nothing. `REFRESH_INTERVAL_MS` is
 * therefore also the worst-case delay before an instance notices a breach
 * another instance recorded, and before every instance notices a row an
 * operator cleared.
 *
 * ## What a failure here must not do
 *
 * Fail open loudly rather than quietly, and never take the request with it.
 * A refresh that cannot reach the database leaves the previous shared state in
 * place and logs; it does not clear the latch, and it does not throw into a
 * chat turn. The process-local half of the latch is unaffected either way, so
 * an instance that saw the overshoot itself keeps refusing regardless of what
 * the database says.
 */

import { prisma } from "@/lib/prisma";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import { applyDurableSearchQueryCeilingBreaches } from "@/lib/webSearchNativeCostReservation";

/** One row per provider. The suffix is the provider, so the prefix is the set. */
const KEY_PREFIX = "webSearch.searchCeilingBreached.";

const keyFor = (provider: string) => `${KEY_PREFIX}${provider}`;
const providerFromKey = (key: string) => key.slice(KEY_PREFIX.length);

/**
 * How long a process may go on believing what it last read.
 *
 * A minute is chosen against the two things it delays: an instance learning
 * about another instance's breach, and every instance learning that an
 * operator cleared one. Both are minutes-scale concerns, and a shorter
 * interval would buy nothing for a state that changes a handful of times a
 * year.
 */
export const REFRESH_INTERVAL_MS = 60_000;

let lastRefreshedAt = 0;
let inFlight: Promise<void> | null = null;

/** Test seam. Never called on a request path. */
export const resetSearchQueryCeilingBreachCache = () => {
    lastRefreshedAt = 0;
    inFlight = null;
};

/**
 * Records a breach so it survives this process.
 *
 * Awaited by its caller rather than fired and forgotten: the write is the
 * thing that makes the latch mean anything past a redeploy, and a caller that
 * did not wait for it could not report that it failed. It still cannot throw
 * -- the breach has already happened, and failing the settlement that noticed
 * it would lose the ledger entry as well as the latch.
 */
export const persistSearchQueryCeilingBreach = async (
    provider: string,
    detail: { observedQueries: number; authorizedQueries: number }
): Promise<boolean> => {
    if (isE2EDatabaseDisabled()) return false;
    const value = JSON.stringify({
        observedQueries: detail.observedQueries,
        authorizedQueries: detail.authorizedQueries,
    });
    try {
        await prisma.appSetting.upsert({
            where: { key: keyFor(provider) },
            create: { key: keyFor(provider), value },
            update: { value },
        });
        // The next reader must not serve a snapshot taken before this.
        lastRefreshedAt = 0;
        return true;
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "web_search_ceiling_breach_persist_failed",
                provider,
                message: error instanceof Error ? error.message : "unknown",
            })
        );
        return false;
    }
};

/**
 * Brings this process's shared latch up to date, at most once per interval.
 *
 * Concurrent callers share one query: a burst of chat turns after a cold start
 * would otherwise each open their own.
 */
export const refreshSearchQueryCeilingBreaches = async (): Promise<void> => {
    if (isE2EDatabaseDisabled()) return;
    if (Date.now() - lastRefreshedAt < REFRESH_INTERVAL_MS) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
        try {
            const rows = await prisma.appSetting.findMany({
                where: { key: { startsWith: KEY_PREFIX } },
                select: { key: true },
            });
            applyDurableSearchQueryCeilingBreaches(
                rows.map((row) => providerFromKey(row.key)).filter(Boolean)
            );
            lastRefreshedAt = Date.now();
        } catch (error) {
            // Deliberately not `lastRefreshedAt = Date.now()`: a failed read is
            // not a reading, and pretending otherwise would hold a stale set
            // for a full interval before trying again.
            console.error(
                JSON.stringify({
                    event: "web_search_ceiling_breach_refresh_failed",
                    message: error instanceof Error ? error.message : "unknown",
                })
            );
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
};

/**
 * Clears a provider's durable latch. The operator path, once the overshoot has
 * been dealt with.
 *
 * Every instance resumes within one refresh interval -- except one that saw the
 * overshoot itself, whose process-local half only clears on restart. That
 * asymmetry is deliberate: the instance holding first-hand evidence is the last
 * one that should be talked out of it by a row.
 */
export const clearSearchQueryCeilingBreach = async (provider: string) => {
    if (isE2EDatabaseDisabled()) return;
    await prisma.appSetting.deleteMany({ where: { key: keyFor(provider) } });
    lastRefreshedAt = 0;
};
