/**
 * Reads a response body the caller has no use for, and throws it away.
 *
 * ## Why a fetch has to do this even when it ignores the answer
 *
 * `/api/*` answers `private, no-store` (lib/apiCacheControlPolicy.ts). What was
 * measured alongside that -- on Chromium, against a `next start` build of this
 * application at Next 16.3.0 -- is that a response whose body is never consumed
 * did not reach `requestfinished`, while the same unconsumed body did under
 * `private, no-cache` and `public, max-age=60`. Status did not matter: a 200
 * behaved the same as a 500.
 *
 * Three things that is not. It is not a `Cache-Control` contract: RFC 9111
 * §5.2.2.5 gives `no-store` one meaning, do not store, and says nothing about
 * how long a request stays outstanding. It is not an explained mechanism -- "the
 * cache write drains the body" fits the observations and was not verified. And
 * it is not the `fetch()` promise hanging: that has already resolved, status
 * and headers in hand, and what is outstanding is the body transfer and the
 * request's own completion.
 *
 * The obligation is the same whichever way the cause falls, and it is one the
 * client owes regardless: consume or cancel the body on *every* path, not only
 * the one whose value gets parsed. `res.ok ? res.json() : null` is the shape
 * that gets it wrong.
 *
 * ## Why `text()` and not `body.cancel()`
 *
 * Both settle the request; `text()` is used because it works on a response
 * whose `body` is already `null` -- a 204, a `HEAD`, or a response some
 * intermediary produced without a stream -- where `body.cancel()` would need a
 * guard at every call site. It never rejects: a body that fails mid-read is
 * exactly the case the caller was not going to look at.
 *
 * ## Scope
 *
 * `.github/audits/unconsumed-response-bodies-2026-08-13.md` counts where this
 * is still owed. `app/(site)/(application)/chat/ChatPageClient.tsx` is swept;
 * 57 further browser call sites are not, and the audit deliberately carries no
 * cost estimate because nothing has measured how often each one fires.
 */
export const discardResponseBody = (response: Response): Promise<void> =>
  response.text().then(
    () => undefined,
    () => undefined
  );
