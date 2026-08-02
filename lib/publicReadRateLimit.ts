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
 */
const MAX_TRACKED_CLIENTS = 5_000;

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

export type PublicReadRateLimitResult = {
  allowed: boolean;
  /** Seconds until the window resets. Only meaningful when `allowed` is false. */
  retryAfter: number;
};

export const consumePublicReadBudget = (
  request: Request,
  scope: string
): PublicReadRateLimitResult => {
  const now = Date.now();
  const key = `${scope}:${getAnonymousClientKey(request)}`;
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    if (windows.size >= MAX_TRACKED_CLIENTS) windows.clear();
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
