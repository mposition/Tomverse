"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * Error boundary for the admin console.
 *
 * English on purpose, like the rest of `components/admin/**`: this is an
 * operator surface, not a customer one.
 *
 * The prop is `retry`. Next passed `unstable_retry` in v16.2.0 and renamed it
 * in v16.3.0; the runtime passes `error`, `reset` and `retry` and nothing
 * else, so the old name destructured `undefined` and the retry button threw a
 * `TypeError` of its own. Pinned by `tests/errorBoundaryProps.test.mjs`.
 */
export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6">
      <div className="flex items-center gap-2 text-sm font-bold text-red-100"><AlertTriangle className="h-5 w-5" /> Admin workspace could not be loaded</div>
      <p className="mt-2 text-sm text-red-100/70">
        {/* A digest only exists for a server-side throw; without one there is
            no reference to look up, and naming one there is not sends the
            reader searching the logs for the words "not available". */}
        The operation failed without exposing sensitive server details.{" "}
        {error.digest
          ? `Reference digest ${error.digest} in the server logs.`
          : "This failure produced no digest, so look it up by time in the server logs."}
      </p>
      <button type="button" onClick={() => retry()} className="mt-4 inline-flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm font-bold text-red-100 hover:bg-red-500/20"><RefreshCw className="h-4 w-4" /> Try again</button>
    </div>
  );
}
