"use client";

import { createApiClient } from "@tomverse/api-client";
import { Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { ArtifactPreviewPanelShell } from "@/components/chat/ArtifactPreviewPanelShell";
import { ArtifactPreviewWorkspace } from "@/components/chat/ArtifactPreviewWorkspace";
import { useChatArtifactWorkspace } from "@/components/chat/ChatArtifactWorkspaceContext";
import { useLanguage } from "@/components/LanguageProvider";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { artifactDownloadPath, type ChatStreamArtifact } from "@/lib/generatedArtifactCore";
import { HTML_PREVIEW_MAX_BYTES, isHtmlPreviewSmallEnough } from "@/lib/htmlArtifactPreview";

// The frame and its labels live in their own module; these names stay importable from here.
export { HtmlArtifactPreviewFrame, usePreviewDocumentLabels } from "@/components/chat/HtmlArtifactPreviewFrame";

/**
 * The side panel (desktop) or full-screen sheet (phone) that runs a generated
 * HTML page, or a React source file, in an isolated frame.
 *
 * Policy: docs/policy/generated-artifacts.md section 9. The isolation itself
 * (sandbox tokens, CSP, srcdoc) is `lib/htmlArtifactPreview.ts`; this file is
 * the fetch and the panel around it, and `ArtifactPreviewWorkspace` is the
 * frame and, with the workspace switch on, the code editor.
 *
 * The file is fetched through the same authenticated download route as the
 * download button, so ownership, the conversation lock and the rate limit are
 * that route's, unchanged. Nothing here reads a file by any other path.
 */

type Loaded =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "failed"; message: string }
  | { status: "too_large" };

export function HtmlArtifactPreviewPanel({
  artifact,
  onClose,
  onRevise,
  shareControl,
}: {
  artifact: ChatStreamArtifact;
  onClose: () => void;
  /** Present only when a change can be asked for from here (see GeneratedArtifactCard). */
  onRevise?: (request: string) => Promise<string | null>;
  /** The share button, when this file may be shared. */
  shareControl?: ReactNode;
}) {
  const { t } = useLanguage();
  const workspace = useChatArtifactWorkspace();
  const [loaded, setLoaded] = useState<Loaded>(
    isHtmlPreviewSmallEnough(artifact.byteSize) ? { status: "loading" } : { status: "too_large" }
  );
  const format = artifact.format.toLowerCase();

  useEffect(() => {
    if (!isHtmlPreviewSmallEnough(artifact.byteSize)) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await createApiClient(fetch).response(artifactDownloadPath(artifact.id), { cache: "no-store" });
        if (!response.ok) {
          await discardResponseBody(response);
          if (!cancelled) {
            setLoaded({
              status: "failed",
              message: response.status === 423 ? t("chat.artifactDownloadLocked") : t("chat.artifactPreviewFailed"),
            });
          }
          return;
        }
        const bytes = await response.arrayBuffer();
        if (cancelled) return;
        if (bytes.byteLength > HTML_PREVIEW_MAX_BYTES) {
          setLoaded({ status: "too_large" });
          return;
        }
        setLoaded({ status: "ready", text: new TextDecoder("utf-8").decode(bytes) });
      } catch {
        if (!cancelled) setLoaded({ status: "failed", message: t("chat.artifactPreviewFailed") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifact.byteSize, artifact.id, t]);

  const title = t("chat.artifactPreviewAlt").replaceAll("{filename}", artifact.filename);
  const notice =
    loaded.status === "failed" ? loaded.message
    : loaded.status === "too_large" ? t("chat.artifactPreviewTooLarge")
    : null;

  return (
    <ArtifactPreviewPanelShell title={title} heading={artifact.filename} onClose={onClose} onRevise={onRevise}>
      {notice ? (
        <p role="alert" data-testid="html-artifact-preview-notice" className="p-4 text-sm text-zinc-600 dark:text-zinc-300">{notice}</p>
      ) : loaded.status === "loading" ? (
        <p role="status" className="flex items-center gap-2 p-4 text-sm text-zinc-500 dark:text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          {t("chat.artifactPreviewLoading")}
        </p>
      ) : loaded.status === "ready" ? (
        <ArtifactPreviewWorkspace
          // React source is a file the model wrote, not a page: it becomes one in the frame, as a code block does.
          source={{
            kind: format === "jsx" || format === "tsx" ? "react" : "html",
            language: format,
            original: loaded.text,
            artifactId: artifact.id,
            filename: artifact.filename,
          }}
          title={title}
          editable={workspace.enabled}
          fillComposer={workspace.fillComposer}
          onClose={onClose}
          shareControl={shareControl}
        />
      ) : null}
    </ArtifactPreviewPanelShell>
  );
}
