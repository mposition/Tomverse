import "server-only";

import { getAnonymousClientKey } from "@/lib/clientIp";

/**
 * SEC-012. A per-process request ceiling for the unauthenticated read
 * endpoints.
 *
 * The database amplification these endpoints had is closed by
 * `lib/publicSnapshotCache.ts`: a burst now costs one query per TTL rather than
 * one per request. This is the second, smaller half -- it bounds the CPU and
 * bandwidth of *serving* that snapshot to a caller looping on it.
 *
 * Deliberately in-process and not backed by `ChatUsageBucket`: the point is to
 * survive a flood without touching PostgreSQL, so a limiter that writes a row
 * per request would reintroduce exactly the amplification being removed. That
 * makes it per-replica rather than global, which is the correct trade here --
 * the edge (Cloudflare) is where a global limit belongs, and this is the
 * origin's own floor under it.
 *
 * The limit is set far above any legitimate client. `ModelCatalogProvider`
 * fetches the catalogue once per mount plus once per registry-update event; a
 * user would have to reload roughly twice a second for a minute to reach it.
 * That headroom is intentional, because `getAnonymousClientKey` falls back to a
 * coarse fingerprint when the trusted-proxy IP header is not resolvable, and
 * unrelated users sharing a bucket must not throttle each other.
 */

const WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 120;

/**
 * Caps memory. The map is keyed by a client fingerprint, so it must not be
 * allowed to grow with the number of distinct callers -- that would turn the
 * limiter into the resource-exhaustion primitive it exists to prevent. On
 * overflow the whole window is dropped, which fails *open* (callers get a fresh
 * allowance) rather than closed.
 *
 * Nothing evicts on a timer, so an entry outlives its window until that same
 * key comes back. Ordinary traffic is mostly one-shot visitors and the key
 * carries the scope, so a caller reading two public endpoints occupies two
 * entries: the map fills with *expired* entries long before it holds anything
 * like this many live ones. Reaching the cap that way and clearing everything
 * would hand a fresh allowance to whoever was being limited at that moment --
 * a limiter that resets itself on a schedule set by unrelated traffic. So the
 * expired entries go first, and the blunt clear is what happens only when they
 * were not the problem.
 */
const MAX_TRACKED_CLIENTS = 5_000;

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

/**
 * Makes room at the cap, preferring the entries that are already meaningless.
 *
 * Only reached when the map is full, so the cost is paid once per fill rather
 * than per request. Clearing outright stays the fallback for the case it was
 * written for -- more live windows than the cap allows -- where there is no
 * dead weight to drop and fail-open is the deliberate choice.
 */
const evictAtCapacity = (now: number) => {
  for (const [trackedKey, window] of windows) {
    if (window.resetAt <= now) windows.delete(trackedKey);
  }
  if (windows.size >= MAX_TRACKED_CLIENTS) windows.clear();
};

export type PublicReadRateLimitResult = {
  allowed: boolean;
  /** Seconds until the window resets. Only meaningful when `allowed` is false. */
  retryAfter: number;
};

export const consumePublicReadBudget = (
  request: Request,
  scope: string,
  /**
   * Injected only by tests. The window and the eviction below are both defined
   * against elapsed time, and neither can be exercised by a suite that can
   * only move the clock by however long it takes to run.
   */
  now: number = Date.now()
): PublicReadRateLimitResult => {
  const key = `${scope}:${getAnonymousClientKey(request)}`;
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    if (windows.size >= MAX_TRACKED_CLIENTS) evictAtCapacity(now);
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }

  existing.count += 1;
  if (existing.count > REQUESTS_PER_WINDOW) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, retryAfter: 0 };
};

/** Test seam. Never called by application code. */
export const resetPublicReadRateLimitForTests = () => {
  windows.clear();
};

export const PUBLIC_READ_RATE_LIMIT = {
  windowMs: WINDOW_MS,
  requestsPerWindow: REQUESTS_PER_WINDOW,
  maxTrackedClients: MAX_TRACKED_CLIENTS,
} as const;
