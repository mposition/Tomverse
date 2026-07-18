"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

export default function AdminError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6">
      <div className="flex items-center gap-2 text-sm font-black text-red-100"><AlertTriangle className="h-5 w-5" /> Admin workspace could not be loaded</div>
      <p className="mt-2 text-sm text-red-100/70">The operation failed without exposing sensitive server details. Reference digest {error.digest || "not available"} in the server logs.</p>
      <button type="button" onClick={() => unstable_retry()} className="mt-4 inline-flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm font-black text-red-100 hover:bg-red-500/20"><RefreshCw className="h-4 w-4" /> Try again</button>
    </div>
  );
}
