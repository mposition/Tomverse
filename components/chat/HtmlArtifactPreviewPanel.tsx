"use client";

import { createApiClient } from "@tomverse/api-client";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ArtifactPreviewPanelShell } from "@/components/chat/ArtifactPreviewPanelShell";
import { useLanguage } from "@/components/LanguageProvider";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { artifactDownloadPath, type ChatStreamArtifact } from "@/lib/generatedArtifactCore";
import { buildCodePreviewDocument, type PreviewDocumentLabels } from "@/lib/chatArtifactPreview";
import {
  HTML_PREVIEW_MAX_BYTES,
  HTML_PREVIEW_SANDBOX,
  buildHtmlPreviewSrcdoc,
  isHtmlPreviewSmallEnough,
  withEmbedderNonce,
} from "@/lib/htmlArtifactPreview";

/**
 * The side panel (desktop) or full-screen sheet (phone) that runs a generated
 * HTML page, or a React source file, in an isolated frame.
 *
 * Policy: docs/policy/generated-artifacts.md section 9. The isolation itself
 * (sandbox tokens, CSP, srcdoc) is `lib/htmlArtifactPreview.ts`; this file is
 * the frame, the fetch and the panel around it.
 *
 * The file is fetched through the same authenticated download route as the
 * download button, so ownership, the conversation lock and the rate limit are
 * that route's, unchanged. Nothing here reads a file by any other path.
 */

/** The frame alone: no network, no portal, so it renders anywhere. */
export function HtmlArtifactPreviewFrame({ html, title }: { html: string; title: string }) {
  const srcDoc = useMemo(() => {
    // The embedding document's CSP nonce, if it has one (see withEmbedderNonce).
    // Parsing the untrusted page here fetches nothing: a DOMParser document has no browsing context, so
    // its <img> never becomes "fully active" to load, and <iframe>, <link>, <script>, <video> and srcset
    // need a browsing context to fetch at all (measured in Chromium: zero requests for each of them).
    // Scripts in it never run. Only the rewritten text leaves this function, into the sandboxed frame.
    const nonce = typeof document === "undefined" ? null : document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
    const page = typeof DOMParser === "undefined" ? html : withEmbedderNonce(html, nonce, (text) => new DOMParser().parseFromString(text, "text/html"));
    return buildHtmlPreviewSrcdoc(page, typeof window === "undefined" ? null : window.location.origin);
  }, [html]);
  return (
    <iframe
      data-testid="html-artifact-preview-frame"
      title={title}
      sandbox={HTML_PREVIEW_SANDBOX}
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      allow=""
      className="h-full w-full flex-1 border-0 bg-white"
    />
  );
}

/** The sentences a React preview shows inside its own frame when it cannot run. */
export function usePreviewDocumentLabels(): PreviewDocumentLabels {
  const { t } = useLanguage();
  return useMemo(
    () => ({
      errorTitle: t("chat.artifactWorkspaceErrorTitle"),
      loadFailed: t("chat.artifactWorkspaceLoadFailed"),
      noComponent: t("chat.artifactWorkspaceNoComponent"),
      missingPackage: t("chat.artifactWorkspaceMissingPackage"),
    }),
    [t]
  );
}

type Loaded =
  | { status: "loading" }
  | { status: "ready"; html: string }
  | { status: "failed"; message: string }
  | { status: "too_large" };

export function HtmlArtifactPreviewPanel({
  artifact,
  onClose,
  onRevise,
}: {
  artifact: ChatStreamArtifact;
  onClose: () => void;
  /** Present only when a change can be asked for from here (see GeneratedArtifactCard). */
  onRevise?: (request: string) => Promise<string | null>;
}) {
  const { t } = useLanguage();
  const labels = usePreviewDocumentLabels();
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
        const text = new TextDecoder("utf-8").decode(bytes);
        if (format === "jsx" || format === "tsx") {
          // React source is a file the model wrote, not a page: it becomes one here, and runs in the same frame.
          const built = buildCodePreviewDocument("react", text, { language: format, labels, assetOrigin: window.location.origin });
          setLoaded(built.ok ? { status: "ready", html: built.html } : { status: "too_large" });
        } else {
          setLoaded({ status: "ready", html: text });
        }
      } catch {
        if (!cancelled) setLoaded({ status: "failed", message: t("chat.artifactPreviewFailed") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifact.byteSize, artifact.id, format, labels, t]);

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
        <HtmlArtifactPreviewFrame html={loaded.html} title={title} />
      ) : null}
    </ArtifactPreviewPanelShell>
  );
}
