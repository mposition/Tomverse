import Link from "next/link";

/**
 * Custom 404. Without this file Next serves its built-in fallback, which renders
 * a bare `404` with hard-coded #000-on-#fff and injects its styling through an
 * inline <style> element - blocked outright once `CSP_MODE=enforce`, because the
 * production policy is `style-src 'self' 'nonce-...'` with no 'unsafe-inline'.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <p className="text-xs font-black uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
        404
      </p>
      <h1 className="text-balance text-2xl font-black text-zinc-900 dark:text-zinc-50">
        We couldn&apos;t find that page
      </h1>
      <p className="max-w-md text-sm leading-6 text-zinc-600 dark:text-zinc-300">
        The link may be out of date, or the page may have moved. Nothing is wrong
        with your account.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/"
          className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white transition hover:bg-blue-500"
        >
          Go to the homepage
        </Link>
        <Link
          href="/chat"
          className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-black text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          Open the chat workspace
        </Link>
        <Link
          href="/support"
          className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-black text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          Contact support
        </Link>
      </div>
    </main>
  );
}
