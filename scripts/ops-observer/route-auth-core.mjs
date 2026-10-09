// Who is calling an ops-observer internal route (docs/policy/sre-ops.md §7, §8).
//
// The app holds the two service secrets. A secret that is not set (or is
// shorter than 32 characters) authenticates nothing, and with neither usable
// every route answers 404 -- removing the route secret is the documented way
// to stop the agent, and a stopped route should not confirm it exists. Two
// equal secrets are a misconfiguration that would let either service act as
// the other, so they count as unset too.
//
// The bearer is compared with each usable secret as SHA-256 digests in
// constant time. The page service may call every route but the digest
// submission; the digest service is refused advance and confirm (§7). Either
// refusal is 403 rather than 401 because the secret is valid -- it is the
// route that is not its own.

import { createHash, timingSafeEqual } from "node:crypto";

export const PAGE_SECRET_ENV = "OPS_OBSERVER_SECRET";
export const DIGEST_SECRET_ENV = "OPS_OBSERVER_DIGEST_SECRET";
export const MIN_SECRET_LENGTH = 32;

/** The internal routes and the services each one admits. */
export const ROUTE_SERVICES = Object.freeze({
  "ops-snapshot": Object.freeze(["page", "digest"]),
  state: Object.freeze(["page", "digest"]),
  advance: Object.freeze(["page"]),
  confirm: Object.freeze(["page"]),
  digest: Object.freeze(["digest"]),
});

const digest = (value) => createHash("sha256").update(value, "utf8").digest();
const usable = (value) => typeof value === "string" && value.length >= MIN_SECRET_LENGTH;
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

/**
 * `{ service }` for an admitted caller, otherwise `{ status }`: 404 when the
 * routes are off or the route is unknown, 401 for a missing or wrong bearer,
 * 403 for a valid service on a route that is not its own.
 */
export function opsObserverCaller({ route, authorization, env }) {
  const allowed = Object.hasOwn(ROUTE_SERVICES, route) ? ROUTE_SERVICES[route] : null;
  if (!allowed) return { status: 404 };

  let page = env?.[PAGE_SECRET_ENV];
  let digestSecret = env?.[DIGEST_SECRET_ENV];
  if (usable(page) && usable(digestSecret) && same(page, digestSecret)) {
    page = undefined;
    digestSecret = undefined;
  }
  if (!usable(page) && !usable(digestSecret)) return { status: 404 };

  const header = typeof authorization === "string" ? authorization : "";
  if (!header.startsWith("Bearer ")) return { status: 401 };
  const provided = header.slice("Bearer ".length);
  if (provided.length === 0) return { status: 401 };

  // Both comparisons always run, so the time taken does not say which matched.
  const isPage = usable(page) ? same(page, provided) : false;
  const isDigest = usable(digestSecret) ? same(digestSecret, provided) : false;
  const service = isPage ? "page" : isDigest ? "digest" : null;
  if (!service) return { status: 401 };
  return allowed.includes(service) ? { service } : { status: 403 };
}
