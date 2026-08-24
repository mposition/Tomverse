"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useLanguage } from "@/components/LanguageProvider";

/**
 * Error boundary for the chat workspace.
 *
 * Without it, any render throw in the workspace escapes to Next's built-in
 * boundary, which shows an unbranded, unthemed "Application error: a client-side
 * exception has occurred" with no retry and no way back into the product. The
 * digest is surfaced (and nothing else) so support can correlate with server
 * logs without exposing server internals to the user.
 *
 * The prop is `retry`, not `unstable_retry`. Next passed `unstable_retry` in
 * v16.2.0 and renamed it in v16.3.0 (see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md);
 * the runtime now passes `error`, `reset` and `retry` and nothing else. Reading
 * the old name here did not fail to build and did not warn -- it destructured
 * `undefined`, so the one button whose entire job is recovering from an error
 * threw `TypeError` of its own when pressed, on the screen least able to
 * absorb it. `tests/errorBoundaryProps.test.mjs` now reads the installed
 * runtime and fails if any boundary names a prop it does not pass.
 *
 * This one is localized and the other two are not, which is a difference in
 * audience rather than an oversight: it renders below
 * `app/(site)/(application)/layout.tsx`, so `LanguageProvider` is mounted
 * whenever it renders. `global-error.tsx` replaces the root layout and has no
 * provider to read, and `admin/error.tsx` follows the admin console, which is
 * an English operator surface throughout.
 */
export default function ChatWorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const { t } = useLanguage();

  return (
    <main
      role="alert"
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 px-6 py-16 text-center"
    >
      <div className="flex items-center gap-2 text-sm font-bold text-red-600 dark:text-red-300">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        {t("chat.workspaceError.title")}
      </div>
      <p className="max-w-md text-sm leading-6 text-zinc-600 dark:text-zinc-300">
        {t("chat.workspaceError.body")}{" "}
        {/* A digest only exists for a server-side throw. Without one the old
            copy told the reader to quote the reference "not available", which
            reads as an instruction to repeat those two words to support. */}
        {error.digest ? (
          <>
            {t("chat.workspaceError.reference")}{" "}
            <span className="font-mono font-bold">{error.digest}</span>
          </>
        ) : (
          t("chat.workspaceError.noReference")
        )}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          data-testid="chat-error-retry"
          onClick={() => retry()}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-blue-500"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />{" "}
          {t("chat.workspaceError.retry")}
        </button>
        <Link
          href="/support"
          className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-bold text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          {t("chat.workspaceError.support")}
        </Link>
      </div>
    </main>
  );
}
