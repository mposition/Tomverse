"use client";

import { Eye } from "lucide-react";
import { Children, isValidElement, useCallback, useMemo, useState, type ReactNode, type RefObject } from "react";

import { ArtifactPreviewPanelShell } from "@/components/chat/ArtifactPreviewPanelShell";
import { ArtifactPreviewWorkspace } from "@/components/chat/ArtifactPreviewWorkspace";
import { ArtifactShareControl } from "@/components/chat/ArtifactShareControl";
import { useChatArtifactWorkspace, useCodeBlockStreaming } from "@/components/chat/ChatArtifactWorkspaceContext";
import { useLanguage } from "@/components/LanguageProvider";
import {
  codeLanguageFromClassName,
  codePreviewKindForLanguage,
  type CodePreviewKind,
} from "@/lib/chatArtifactPreview";

/**
 * The "Preview" button on a code block in an answer, and the panel it opens.
 *
 * Policy: docs/policy/generated-artifacts.md section 9. A page the model wrote
 * straight into its answer (no file) runs in the same isolated frame as a
 * generated HTML file. It is a button on the block, not something that runs by
 * itself: nothing executes until the user presses it.
 *
 * It renders nothing unless the workspace switch is on, the fence's language
 * is one that can be previewed, and the answer has finished -- a block still
 * arriving is unfinished code.
 */

const languageOfCode = (children: ReactNode): string | null => {
  for (const child of Children.toArray(children)) {
    if (isValidElement(child)) {
      const className = (child.props as { className?: string }).className;
      const language = codeLanguageFromClassName(className);
      if (language) return language;
    }
  }
  return null;
};

type Opened = {
  kind: CodePreviewKind;
  language: string;
  code: string;
  /** The answer the block is in, from the message element around it (`data-message-id`); null for an unsaved one. */
  messageId: string | null;
  /** The block's position among that answer's blocks, -1 when there is no answer element. */
  blockIndex: number;
};

export function CodeBlockPreview({ children, preRef }: { children: ReactNode; preRef: RefObject<HTMLPreElement | null> }) {
  const { t } = useLanguage();
  const workspace = useChatArtifactWorkspace();
  const streaming = useCodeBlockStreaming();
  const [opened, setOpened] = useState<Opened | null>(null);
  const close = useCallback(() => setOpened(null), []);

  const language = languageOfCode(children);
  const kind = codePreviewKindForLanguage(language);

  const { fillComposer } = workspace;
  const revise = useMemo(
    () =>
      opened && fillComposer
        ? async (request: string) => {
            fillComposer(t("chat.artifactWorkspaceRevisePrompt").replaceAll("{request}", request));
            return null;
          }
        : undefined,
    [opened, fillComposer, t]
  );

  if (!workspace.enabled || streaming || !kind || !language) return null;

  const open = () => {
    // The rendered text, as the copy button reads it. mdast ends every block with the one newline that closes it.
    const code = (preRef.current?.textContent ?? "").replace(/\r?\n$/, "");
    const answer = preRef.current?.closest("[data-message-id]") ?? null;
    const messageId = answer?.getAttribute("data-message-id") || null;
    const blockIndex = answer && preRef.current ? Array.from(answer.querySelectorAll("pre")).indexOf(preRef.current) : -1;
    setOpened({ kind, language, code, messageId, blockIndex });
  };

  const title = t("chat.artifactWorkspaceCodeTitle").replaceAll("{language}", language.toUpperCase());

  return (
    <>
      <button
        type="button"
        data-testid="chat-code-preview-button"
        onClick={open}
        title={t("chat.artifactPreviewOpen")}
        aria-label={`${t("chat.artifactPreviewOpen")}: ${language.toUpperCase()}`}
        className="absolute right-11 top-2 inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-zinc-400 transition-colors before:absolute before:-inset-y-2 before:content-[''] hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        {t("chat.artifactPreviewOpen")}
      </button>
      {opened && (
        <ArtifactPreviewPanelShell title={title} heading={title} onClose={close} onRevise={revise}>
          <ArtifactPreviewWorkspace
            source={{
              kind: opened.kind,
              language: opened.language,
              original: opened.code,
              messageId: opened.messageId,
              blockIndex: opened.blockIndex,
            }}
            title={title}
            editable
            fillComposer={fillComposer}
            onClose={close}
            // A public link to this block's page (generated-artifacts.md section 19); the control asks the server whether it applies.
            renderShare={opened.messageId
              ? ({ edited }) => (
                  <ArtifactShareControl
                    source={{ kind: "code_block", messageId: opened.messageId ?? "", language: opened.language, code: opened.code }}
                    edited={edited}
                  />
                )
              : undefined}
          />
        </ArtifactPreviewPanelShell>
      )}
    </>
  );
}
