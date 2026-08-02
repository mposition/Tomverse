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
export type PublicSnapshotKey = "app-settings" | "model-catalog";

const TTL_MS: Record<PublicSnapshotKey, number> = {
  // Short enough that an operational flag flip (chat disabled during an
  // incident) reaches users promptly even if the invalidation below is missed.
  "app-settings": 10_000,
  "model-catalog": 10_000,
};

type Snapshot<T> = {
  value: T;
  etag: string;
  expiresAt: number;
};

const snapshots = new Map<PublicSnapshotKey, Snapshot<unknown>>();
const inFlight = new Map<PublicSnapshotKey, Promise<Snapshot<unknown>>>();

const weakEtag = (serialized: string) =>
  `W/"${createHash("sha256").update(serialized).digest("base64url").slice(0, 27)}"`;

/**
 * Drops a snapshot so the next read reloads it. Called by the admin write
 * paths, which would otherwise leave the console showing what it just changed
 * as unchanged for up to the TTL.
 */
export const invalidatePublicSnapshot = (key: PublicSnapshotKey) => {
  snapshots.delete(key);
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

  const load$ = (async () => {
    const value = await load();
    const snapshot: Snapshot<T> = {
      value,
      etag: weakEtag(JSON.stringify(value)),
      expiresAt: Date.now() + TTL_MS[key],
    };
    snapshots.set(key, snapshot as Snapshot<unknown>);
    return snapshot as Snapshot<unknown>;
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, load$);
  return (await load$) as Snapshot<T>;
};

/** Test seam. Never called by application code. */
export const resetPublicSnapshotCacheForTests = () => {
  snapshots.clear();
  inFlight.clear();
};
