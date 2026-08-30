import "server-only";

import { createHash } from "node:crypto";

/**
 * SEC-012. `/api/app-settings` and `/api/models/catalog` are unauthenticated,
 * uncached, and hit PostgreSQL on every request -- and the catalogue is fetched
 * by `ModelCatalogProvider` on every page load, so a trivial loop against
 * either one converts one attacker connection into one database query, with no
 * rate limit in front of it. Both answer with data that is identical for every
 * caller, which is what makes a shared snapshot correct here.
 *
 * Three things happen in this module:
 *
 * 1. A TTL cache, so a burst of N requests costs one query rather than N.
 * 2. Single flight, so the burst that arrives while the query is in progress
 *    waits on that query instead of starting N more. Without this the cache
 *    would still let a cold start be amplified.
 * 3. A weak ETag over the serialized payload, so a client that already has the
 *    current snapshot gets a 304 with no body.
 *
 * The cache is a fixed set of named keys declared below, not a map keyed by
 * anything a caller controls -- an attacker-supplied key would make this a
 * memory-exhaustion primitive rather than a defence against one.
 *
 * A failed load is not cached: the next request retries. These snapshots gate
 * whether chat is enabled at all, so serving a stale-forever error would be
 * worse than the query.
 */

/** The complete set of cacheable snapshots. Not extensible at runtime. */
export type PublicSnapshotKey =
  | "app-settings"
  | "model-catalog"
  | "image-generation-flag"
  | "external-continuation-flag";

const TTL_MS: Record<PublicSnapshotKey, number> = {
  // Short enough that an operational flag flip (chat disabled during an
  // incident) reaches users promptly even if the invalidation below is missed.
  "app-settings": 10_000,
  "model-catalog": 10_000,
  // Read once per chat turn to decide what the image-capability system block
  // says. Its own key rather than a field on `app-settings`, because that
  // snapshot is what `/api/app-settings` serves to anyone who asks and this
  // flag is a beta rollout state; sharing the entry would publish it. Same
  // TTL, and the admin toggle invalidates it, so an operator who turns image
  // generation off does not keep being announced.
  "image-generation-flag": 10_000,
  // Read once per authenticated chat turn that names a conversation, to decide
  // whether to look for a continuation bridge at all
  // (docs/policy/external-conversation-continuation.md §7). Its own key for the
  // same two reasons the image flag has one: `app-settings` is served to
  // anyone who asks, and this is default-off rollout state. Same TTL, and the
  // admin toggle invalidates it, so turning continuation off stops the
  // injection now rather than in ten seconds' time.
  "external-continuation-flag": 10_000,
};

type Snapshot<T> = {
  value: T;
  etag: string;
  expiresAt: number;
};

const snapshots = new Map<PublicSnapshotKey, Snapshot<unknown>>();
const inFlight = new Map<PublicSnapshotKey, Promise<Snapshot<unknown>>>();

/**
 * Fences a load against the invalidation that happened while it was running.
 *
 * A load reads the database, then writes what it read into the cache. If a
 * write lands between those two moments, deleting the snapshot achieves
 * nothing: the load is still holding pre-write data and stores it afterwards
 * with a full TTL, so the change the admin just made is reverted for up to ten
 * seconds -- which is the exact failure invalidation exists to prevent, and it
 * is invisible because the invalidate call did happen.
 *
 * So the load records the generation it started in and stores its result only
 * if that generation is still current. Same shape as the extraction lease
 * fence: a deadline cannot decide this, only an explicit token can.
 */
const generations = new Map<PublicSnapshotKey, number>();
const generationOf = (key: PublicSnapshotKey) => generations.get(key) ?? 0;

const weakEtag = (serialized: string) =>
  `W/"${createHash("sha256").update(serialized).digest("base64url").slice(0, 27)}"`;

/**
 * Drops a snapshot so the next read reloads it. Called by the admin write
 * paths, which would otherwise leave the console showing what it just changed
 * as unchanged for up to the TTL.
 */
export const invalidatePublicSnapshot = (key: PublicSnapshotKey) => {
  snapshots.delete(key);
  generations.set(key, generationOf(key) + 1);
  // Also stops a caller arriving now from joining a load that already read
  // stale data. That load still resolves for whoever was waiting on it before
  // the write -- they asked before the change existed -- but it is no longer
  // what anyone new gets.
  inFlight.delete(key);
};

export const readPublicSnapshot = async <T>(
  key: PublicSnapshotKey,
  load: () => Promise<T>
): Promise<{ value: T; etag: string }> => {
  const cached = snapshots.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached as Snapshot<T>;
  }

  const pending = inFlight.get(key);
  if (pending) return (await pending) as Snapshot<T>;

  const startedIn = generationOf(key);
  const load$: Promise<Snapshot<unknown>> = (async () => {
    const value = await load();
    const snapshot: Snapshot<T> = {
      value,
      etag: weakEtag(JSON.stringify(value)),
      expiresAt: Date.now() + TTL_MS[key],
    };
    // Invalidated while this was running: the value is already known to be
    // out of date, so it is returned to the callers who are waiting on it and
    // not written anywhere.
    if (generationOf(key) === startedIn) {
      snapshots.set(key, snapshot as Snapshot<unknown>);
    }
    return snapshot as Snapshot<unknown>;
  })().finally(() => {
    // Only if this is still the entry it registered. An invalidation may have
    // dropped it already and a newer load taken the slot, and deleting that
    // one would send the next burst back to the database.
    if (inFlight.get(key) === load$) inFlight.delete(key);
  });

  inFlight.set(key, load$);
  return (await load$) as Snapshot<T>;
};

/** Test seam. Never called by application code. */
export const resetPublicSnapshotCacheForTests = () => {
  snapshots.clear();
  inFlight.clear();
};
