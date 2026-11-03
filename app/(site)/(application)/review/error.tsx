"use client";

import { WorkspaceErrorScreen } from "@/components/WorkspaceErrorScreen";

/**
 * Error boundary for the Tomverse Review workspace.
 *
 * `/review` renders the same shell and the same navigation rail as `/chat`,
 * but had no boundary of its own, so a throw here fell all the way through to
 * Next's built-in one -- untranslated, unstyled, with no retry and no support
 * link. That is the screen a reader got when the rail's former one-segment
 * help link turned a click into "Expected RSC response, got text/html".
 *
 * The prop is `retry`; see `chat/error.tsx` and `tests/errorBoundaryProps.test.mjs`.
 */
export default function ReviewWorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <WorkspaceErrorScreen
      titleKey="chat.workspaceError.workspaceTitle"
      bodyKey="chat.workspaceError.workspaceBody"
      digest={error.digest}
      onRetry={() => retry()}
      retryTestId="review-error-retry"
    />
  );
}
