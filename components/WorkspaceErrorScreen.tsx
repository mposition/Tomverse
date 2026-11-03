"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useLanguage } from "@/components/LanguageProvider";

/**
 * The failure screen an application workspace's `error.tsx` boundary renders.
 *
 * It exists because every workspace boundary has to say the same two things --
 * "try again" and "here is the way to support" -- in the reader's language,
 * and only `/chat` did. `/review` and `/plugins` render the same navigation
 * rail and had no boundary at all, so a throw there escaped to Next's built-in
 * one: an unstyled English "Application error: a client-side exception has
 * occurred", with no retry and no support path. A dead `<Link>` is one such
 * throw -- a client-side navigation to a path with no page of its own gets the
 * 404 *document* back for its RSC request and Next raises "Expected RSC
 * response, got text/html" -- and that is how the rail's former one-segment
 * help link failed. The link is fixed and guarded by
 * `tests/singleSegmentLinkTargets.test.mjs`; this is the landing that was
 * missing underneath it.
 *
 * Only `error.digest` is surfaced, so support can correlate with server logs
 * without server internals reaching the reader. A digest only exists for a
 * server-side throw; without one the sentence changes rather than taking a
 * placeholder in a "quote this reference" instruction.
 *
 * `retry` stays in the boundary file and arrives here as `onRetry`: the prop
 * name is a contract with the Next runtime, and `tests/errorBoundaryProps.test.mjs`
 * reads the installed runtime to check each boundary still names it correctly.
 */
export function WorkspaceErrorScreen({
  titleKey,
  bodyKey,
  digest,
  onRetry,
  retryTestId,
}: {
  /** `t()` key for the heading, so each workspace names itself. */
  titleKey: string;
  bodyKey: string;
  digest?: string;
  onRetry: () => void;
  retryTestId: string;
}) {
  const { t } = useLanguage();

  return (
    <main
      role="alert"
      data-testid="workspace-error"
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 px-6 py-16 text-center"
    >
      <div className="flex items-center gap-2 text-sm font-bold text-red-600 dark:text-red-300">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        {t(titleKey)}
      </div>
      <p className="max-w-md text-sm leading-6 text-zinc-600 dark:text-zinc-300">
        {t(bodyKey)}{" "}
        {digest ? (
          <>
            {t("chat.workspaceError.reference")}{" "}
            <span className="font-mono font-bold">{digest}</span>
          </>
        ) : (
          t("chat.workspaceError.noReference")
        )}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          data-testid={retryTestId}
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-blue-500"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />{" "}
          {t("chat.workspaceError.retry")}
        </button>
        <Link
          href="/support"
          data-testid="workspace-error-support"
          className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-bold text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          {t("chat.workspaceError.support")}
        </Link>
      </div>
    </main>
  );
}
