/**
 * What an API response says about caching, and who decides it.
 *
 * Next.js attaches no `Cache-Control` to an App Router route handler's
 * response. A response with no cache directive and a cacheable status is not
 * "uncacheable" -- it is heuristically cacheable, and a shared cache may store
 * and reuse it (RFC 9111 §4.2.2). Forty-one authenticated GET routes here sent
 * none: the conversation list, account settings, usage, billing and most of
 * the admin console. Whether one account's response could be handed to another
 * rested on a CDN's cookie handling rather than on anything this application
 * said.
 *
 * So `/api/*` gets `private, no-store` from the proxy, which is the one place
 * every request already passes through. Setting it there rather than in
 * forty-one route files is not only smaller -- it is the only version that
 * covers the forty-second route somebody adds.
 *
 * The catch, measured rather than assumed: a header set in the proxy (or in
 * next.config's `headers()`) *overrides* a route's own value rather than
 * defaulting behind it. Middleware runs before the handler, so it cannot ask
 * whether the response already chose. A blanket default therefore turned
 * `/api/public/proof-metrics` from its deliberate
 * `public, s-maxage=300, stale-while-revalidate=3600` into `private, no-store`
 * -- a CDN-cached public endpoint back to the origin on every request.
 *
 * Hence this list. It names the routes whose own header must survive, and
 * `npm run check:api-cache-control` fails if a route declares a directive that
 * permits storage or reuse and is not named here. A route that sets a
 * `no-store` variant needs no entry: `private, no-store` says the same thing or
 * more.
 *
 * ## An observation about response bodies this application never reads
 *
 * What was measured, on Chromium against a `next start` build of this
 * application at Next 16.3.0. A response whose body is never consumed -- no
 * `json()`, `text()` or `body.cancel()` -- did not reach `requestfinished`
 * under `private, no-store`. The same unconsumed body did reach it under
 * `private, no-cache` and under `public, max-age=60`. Status did not matter: a
 * 200 behaved the same as a 500.
 *
 * Three things that observation is not.
 *
 * It is not a `Cache-Control` contract. RFC 9111 §5.2.2.5 gives `no-store` one
 * meaning -- do not store -- and says nothing about how long a request stays
 * outstanding; Fetch handles updating the cache and terminating the body as
 * separate steps. So this is behaviour of one browser and one server version,
 * not something a directive promises.
 *
 * It is not an explained mechanism. "The cache write drains the body" fits the
 * three data points and was not verified; nothing here rests on it being right.
 *
 * And it is not the `fetch()` promise hanging. That promise had already
 * resolved -- status and headers arrived. What was outstanding is the body
 * transfer and the request's own completion, which is what `networkidle`
 * counts.
 *
 * The consequence for this repository is concrete either way, and it is
 * something the client owes regardless of the cause: a fetch to `/api/*` has to
 * consume or cancel its body on *every* path, not only the successful one.
 * `res.ok ? res.json() : null` is the shape that gets it wrong, and
 * `app/(site)/(application)/chat/ChatPageClient.tsx` had it: with the database
 * unreachable, `/api/user/guest-usage` answered 500, the body was never read,
 * and `/chat` never reached network idle again.
 *
 * ### What is and is not covered
 *
 * `ChatPageClient.tsx` has been swept -- all 26 of its fetch call sites, every
 * branch. `tests/e2e/guest-flow.spec.ts` proves exactly one of them: the guest
 * boot path's 500. No test yet covers a success path, a fire-and-forget write,
 * or any other file.
 *
 * Everywhere else is unsurveyed. The same shapes exist in the admin panels and
 * the import flows, and how much they actually cost is not known: a screen that
 * retries, polls, or is driven repeatedly by a user accumulates outstanding
 * requests rather than holding one. Sizing that needs the inventory, not a
 * guess, and the inventory has not been done.
 */
export type ApiCachingException = {
  /** Exact pathname, matched after the trailing slash is normalised away. */
  pathname: string;
  /** The route file, so the check can confirm the entry still describes it. */
  route: string;
  reason: string;
};

export const API_ROUTES_CHOOSING_THEIR_OWN_CACHING: readonly ApiCachingException[] =
  [
    {
      pathname: "/api/public/proof-metrics",
      route: "app/api/public/proof-metrics/route.ts",
      reason:
        "Public marketing metrics, deliberately cached at the edge with s-maxage and stale-while-revalidate. It carries no account data and is the one endpoint here whose whole point is being served from a shared cache.",
    },
    {
      pathname: "/api/models/status",
      route: "app/api/models/status/route.ts",
      reason:
        "Provider status, public and short-lived (max-age with stale-while-revalidate). Every visitor gets the same answer, and serving it from cache is what keeps a provider incident from also being a traffic spike.",
    },
    {
      pathname: "/api/models/catalog",
      route: "app/api/models/catalog/route.ts",
      reason:
        "`private, no-cache` is not `no-store`: the response may be stored and must be revalidated before reuse. The catalogue answers from a shared snapshot (SEC-012) and relies on that distinction.",
    },
    {
      pathname: "/api/app-settings",
      route: "app/api/app-settings/route.ts",
      reason: "Same `private, no-cache` revalidation contract as the catalogue.",
    },
    {
      pathname: "/api/chat",
      route: "app/api/chat/route.ts",
      reason:
        "The streaming response sets `no-cache, no-transform`. `no-transform` is the load-bearing half -- it stops an intermediary compressing or buffering the stream, which is what makes a token appear when it is produced rather than at the end.",
    },
  ];

const normalise = (pathname: string) =>
  pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;

export const isApiPathname = (pathname: string) => pathname.startsWith("/api/");

/** Whether this route sets its own `Cache-Control` and must keep it. */
export const apiRouteChoosesOwnCaching = (pathname: string) =>
  API_ROUTES_CHOOSING_THEIR_OWN_CACHING.some(
    (exception) => exception.pathname === normalise(pathname)
  );

export const DEFAULT_API_CACHE_CONTROL = "private, no-store";
