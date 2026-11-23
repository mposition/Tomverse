"use client";

import { WorkspaceErrorScreen } from "@/components/WorkspaceErrorScreen";

export default function StudioWorkspaceError({ error, retry }: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <WorkspaceErrorScreen
      titleKey="chat.workspaceError.workspaceTitle"
      bodyKey="chat.workspaceError.workspaceBody"
      digest={error.digest}
      onRetry={() => retry()}
      retryTestId="studio-error-retry"
    />
  );
}
