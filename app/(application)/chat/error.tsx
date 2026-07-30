"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import Link from "next/link";

/**
 * Error boundary for the chat workspace.
 *
 * Without it, any render throw in the workspace escapes to Next's built-in
 * boundary, which shows an unbranded, unthemed "Application error: a client-side
 * exception has occurred" with no retry and no way back into the product. The
 * digest is surfaced (and nothing else) so support can correlate with server
 * logs without exposing server internals to the user.
 */
export default function ChatWorkspaceError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <main
      role="alert"
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 px-6 py-16 text-center"
    >
      <div className="flex items-center gap-2 text-sm font-black text-red-600 dark:text-red-300">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        The chat workspace could not be loaded
      </div>
      <p className="max-w-md text-sm leading-6 text-zinc-600 dark:text-zinc-300">
        Your conversations are safe. Retrying usually resolves this. If it keeps
        happening, quote reference{" "}
        <span className="font-mono font-bold">
          {error.digest || "not available"}
        </span>{" "}
        when you contact support.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          data-testid="chat-error-retry"
          onClick={() => unstable_retry()}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white transition hover:bg-blue-500"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
        </button>
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
