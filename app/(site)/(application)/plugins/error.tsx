"use client";

import { WorkspaceErrorScreen } from "@/components/WorkspaceErrorScreen";

/**
 * Error boundary for the connectors workspace.
 *
 * `/plugins` renders the same navigation rail as `/chat` and `/review`
 * (`ReviewNavigation`), so it can fail the same way and had the same gap: no
 * boundary, and therefore Next's untranslated built-in screen with no retry.
 *
 * The prop is `retry`; see `chat/error.tsx` and `tests/errorBoundaryProps.test.mjs`.
 */
export default function PluginsWorkspaceError({
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
      retryTestId="plugins-error-retry"
    />
  );
}
