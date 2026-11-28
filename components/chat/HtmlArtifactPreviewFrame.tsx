"use client";

import { useMemo } from "react";

import { useLanguage } from "@/components/LanguageProvider";
import type { PreviewDocumentLabels } from "@/lib/chatArtifactPreview";
import { HTML_PREVIEW_SANDBOX, buildHtmlPreviewSrcdoc, withEmbedderNonce } from "@/lib/htmlArtifactPreview";

/**
 * The isolated frame a preview runs in, alone: no network, no portal, so it
 * renders anywhere. Policy: docs/policy/generated-artifacts.md section 9; the
 * isolation itself (sandbox tokens, CSP, srcdoc) is lib/htmlArtifactPreview.ts.
 */
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
