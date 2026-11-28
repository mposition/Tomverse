"use client";

import { useEffect, useMemo, useState } from "react";

import { useLanguage } from "@/components/LanguageProvider";
import type { PreviewDocumentLabels } from "@/lib/chatArtifactPreview";
import {
  HTML_PREVIEW_SANDBOX,
  HtmlPreviewUnavailableError,
  buildHtmlPreviewSrcdoc,
  mentionsDeclarativeShadowRoot,
  withEmbedderNonce,
  type TemplateStartFinder,
} from "@/lib/htmlArtifactPreview";

/**
 * The template finder (parse5) is loaded only for a page that names
 * `shadowrootmode`, so it stays out of the chat's first bundle. One load for
 * the whole tab; a failed load is tried again the next time a preview needs it.
 */
let templateFinder: Promise<TemplateStartFinder> | null = null;
const loadTemplateFinder = () => {
  templateFinder ??= import("@/lib/htmlPreviewTemplateStarts").then(
    (module) => module.findTemplateStartTags,
    (error: unknown) => {
      templateFinder = null;
      throw error;
    }
  );
  return templateFinder;
};

type Finder = { find: TemplateStartFinder } | { failed: true } | null;

/**
 * The isolated frame a preview runs in, alone: no network, no portal, so it
 * renders anywhere. Policy: docs/policy/generated-artifacts.md section 9; the
 * isolation itself (sandbox tokens, CSP, srcdoc) is lib/htmlArtifactPreview.ts.
 * A page whose declarative shadow roots cannot be opened is not drawn: it says
 * the preview could not run instead.
 */
export function HtmlArtifactPreviewFrame({ html, title }: { html: string; title: string }) {
  const { t } = useLanguage();
  const prepared = useMemo(() => {
    // The embedding document's CSP nonce, if it has one (see withEmbedderNonce).
    // Parsing the untrusted page here fetches nothing: a DOMParser document has no browsing context, so
    // its <img> never becomes "fully active" to load, and <iframe>, <link>, <script>, <video> and srcset
    // need a browsing context to fetch at all (measured in Chromium: zero requests for each of them).
    // Scripts in it never run. Only the rewritten text leaves this function, into the sandboxed frame.
    const nonce = typeof document === "undefined" ? null : document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
    const page = typeof DOMParser === "undefined" ? html : withEmbedderNonce(html, nonce, (text) => new DOMParser().parseFromString(text, "text/html"));
    return { nonce, page, origin: typeof window === "undefined" ? null : window.location.origin };
  }, [html]);
  const needsFinder = mentionsDeclarativeShadowRoot(prepared.page);
  const [finder, setFinder] = useState<Finder>(null);

  useEffect(() => {
    if (!needsFinder) return;
    let live = true;
    loadTemplateFinder().then(
      (find) => {
        if (live) setFinder({ find });
      },
      () => {
        if (live) setFinder({ failed: true });
      }
    );
    return () => {
      live = false;
    };
  }, [needsFinder]);

  const frame = useMemo((): { srcDoc: string } | { unavailable: string } | null => {
    if (needsFinder && finder === null) return null;
    if (needsFinder && finder && "failed" in finder) return { unavailable: t("chat.artifactWorkspaceLoadFailed") };
    try {
      // The guard script ahead of the page needs the same nonce, or the app's policy would block it.
      return {
        srcDoc: buildHtmlPreviewSrcdoc(prepared.page, prepared.origin, {
          nonce: prepared.nonce,
          findTemplates: finder && "find" in finder ? finder.find : undefined,
        }),
      };
    } catch (error) {
      if (error instanceof HtmlPreviewUnavailableError) return { unavailable: t("chat.artifactWorkspaceErrorTitle") };
      throw error;
    }
  }, [prepared, needsFinder, finder, t]);

  if (!frame) return <div data-testid="html-artifact-preview-loading" aria-busy="true" className="h-full w-full flex-1 bg-white" />;
  if ("unavailable" in frame) {
    return (
      <div
        role="status"
        data-testid="html-artifact-preview-unavailable"
        className="flex h-full w-full flex-1 items-center justify-center p-6 text-center text-sm text-gray-600"
      >
        {frame.unavailable}
      </div>
    );
  }
  return (
    <iframe
      data-testid="html-artifact-preview-frame"
      title={title}
      sandbox={HTML_PREVIEW_SANDBOX}
      srcDoc={frame.srcDoc}
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
