import { NotFoundContent } from "@/components/NotFoundContent";

/**
 * The boundary a `notFound()` thrown inside a route renders into -- for
 * example `app/[locale]/layout.tsx` refusing an unknown locale. It composes
 * with whichever root layout the route sits under, so it renders the body and
 * nothing else.
 *
 * A URL that matches no route at all cannot use this file: that 404 has no
 * route, so there is no root layout to compose with, and this app has two of
 * them. Next answered every such request with "not-found.tsx doesn't have a
 * root layout" and a 500. `app/global-not-found.tsx` is that case, and the
 * body below is shared with it.
 *
 * Without either file Next serves its built-in fallback, which renders a bare
 * `404` with hard-coded #000-on-#fff and injects its styling through an inline
 * <style> element - blocked outright once `CSP_MODE=enforce`, because the
 * production policy is `style-src 'self' 'nonce-...'` with no 'unsafe-inline'.
 */
export default function NotFound() {
  return <NotFoundContent />;
}
