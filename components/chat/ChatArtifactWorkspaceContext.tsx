"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * The switch and the one write-back the chat gives the in-answer previews.
 *
 * Policy: docs/policy/generated-artifacts.md section 9. `enabled` is the
 * default-off `TOMVERSE_CHAT_ARTIFACT_WORKSPACE_ENABLED` switch, read on the
 * server in ReviewWorkspaceShell and handed down as a prop. Everything the
 * switch guards (the Preview button on a code block, React previews, the
 * "change this screen" box) reads it here, so a surface that never sits under
 * the provider -- a shared page, a test -- shows none of it.
 *
 * `codeRunEnabled` is the separate default-off `TOMVERSE_CHAT_CODE_RUN_ENABLED`
 * switch (lib/chatCodeRun.ts), read the same way: the Run button on a Python
 * block. It does not depend on `enabled`.
 */
type ChatArtifactWorkspace = {
  enabled: boolean;
  codeRunEnabled: boolean;
  /** Puts text at the top of the composer's draft. Null where there is no composer to write to. */
  fillComposer: ((text: string) => void) | null;
};

const WorkspaceContext = createContext<ChatArtifactWorkspace>({ enabled: false, codeRunEnabled: false, fillComposer: null });

export function ChatArtifactWorkspaceProvider({
  enabled,
  codeRunEnabled = false,
  fillComposer,
  children,
}: {
  enabled: boolean;
  codeRunEnabled?: boolean;
  fillComposer: ((text: string) => void) | null;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ enabled, codeRunEnabled, fillComposer }), [enabled, codeRunEnabled, fillComposer]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export const useChatArtifactWorkspace = () => useContext(WorkspaceContext);

/**
 * Whether the answer a code block belongs to is still being written. A block
 * that is still arriving is unfinished code, so it gets no Preview button.
 */
const StreamingContext = createContext(false);

export function CodeBlockStreamingScope({ streaming, children }: { streaming: boolean; children: ReactNode }) {
  return <StreamingContext.Provider value={streaming}>{children}</StreamingContext.Provider>;
}

export const useCodeBlockStreaming = () => useContext(StreamingContext);
