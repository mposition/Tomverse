import Link from "next/link";
import { headers } from "next/headers";
import { SignOutAndSwitchAccountButton } from "@/components/auth/SignOutAndSwitchAccountButton";
import {
  accountSwitchSignInHref,
  isAdminPathname,
} from "@/lib/adminReauthenticationCore";

/**
 * Custom 404. Without this file Next serves its built-in fallback, which renders
 * a bare `404` with hard-coded #000-on-#fff and injects its styling through an
 * inline <style> element - blocked outright once `CSP_MODE=enforce`, because the
 * production policy is `style-src 'self' 'nonce-...'` with no 'unsafe-inline'.
 *
 * ## The account-switch path
 *
 * `/admin/**` answers a signed-in non-administrator with this page rather than a
 * 403, so the console never confirms it exists. That is the right answer and it
 * stays, but on its own it left a visitor stranded: the only account they could
 * use was the one that had just been refused, and the sign-in page forwards an
 * authenticated visitor straight back to where they came from -- the same 404.
 *
 * So a request under `/admin` also offers a way out of the current session. The
 * decision reads the request path and nothing else -- not the session, not
 * whether the path is a real route -- so every visitor to every `/admin` URL
 * sees one identical page. Nothing here names the console, a role or an
 * allowlist.
 */
export default async function NotFound() {
  const requestHeaders = await headers();
  // Set by proxy.ts. A server component cannot read the request URL, and
  // `usePathname()` would move this decision to the client and flash the wrong
  // copy first.
  const pathname = requestHeaders.get("x-tomverse-pathname") || "";
  const search = requestHeaders.get("x-tomverse-search") || "";
  const isAdminRequest = isAdminPathname(pathname);
  // Both halves are raw request input; `accountSwitchSignInHref` normalizes
  // them and falls back to /admin/overview for anything that is not an
  // internal admin path.
  const signInHref = isAdminRequest
    ? accountSwitchSignInHref(`${pathname}${search}`)
    : null;

  const secondaryLinkClass =
    "rounded-xl border border-zinc-300 px-4 py-2 text-sm font-bold text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800";

  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <p className="text-xs font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
        404
      </p>
      <h1 className="text-balance text-2xl font-bold text-zinc-900 dark:text-zinc-50">
        We couldn&apos;t find that page
      </h1>
      <p className="max-w-md text-sm leading-6 text-zinc-600 dark:text-zinc-300">
        {signInHref
          ? // "Nothing is wrong with your account" is not true here: the
            // account really can be the reason, and telling the visitor
            // otherwise is what sent them looking for a fault elsewhere.
            "The link may be out of date, the page may have moved, or you may need to use a different account."
          : "The link may be out of date, or the page may have moved. Nothing is wrong with your account."}
      </p>
      {signInHref ? (
        <div className="mt-2 w-full">
          <SignOutAndSwitchAccountButton signInHref={signInHref} />
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/"
          className={
            signInHref
              ? secondaryLinkClass
              : "rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-blue-500"
          }
        >
          Go to the homepage
        </Link>
        <Link href="/chat" className={secondaryLinkClass}>
          Open the chat workspace
        </Link>
        <Link href="/support" className={secondaryLinkClass}>
          Contact support
        </Link>
      </div>
    </main>
  );
}
