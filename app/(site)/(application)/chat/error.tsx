"use client";

import { WorkspaceErrorScreen } from "@/components/WorkspaceErrorScreen";

/**
 * Error boundary for the chat workspace.
 *
 * Without it, any render throw in the workspace escapes to Next's built-in
 * boundary, which shows an unbranded, unthemed "Application error: a client-side
 * exception has occurred" with no retry and no way back into the product.
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
 * The screen itself is `WorkspaceErrorScreen`, shared with the other
 * application workspaces. It is localized and `admin/error.tsx` and
 * `global-error.tsx` are not, which is a difference in audience rather than an
 * oversight: this renders below `app/(site)/(application)/layout.tsx`, so
 * `LanguageProvider` is mounted whenever it renders. `global-error.tsx`
 * replaces that layout and has no provider to read, and the admin console is
 * an English operator surface throughout.
 */
export default function ChatWorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <WorkspaceErrorScreen
      titleKey="chat.workspaceError.title"
      bodyKey="chat.workspaceError.body"
      digest={error.digest}
      onRetry={() => retry()}
      retryTestId="chat-error-retry"
    />
  );
}
