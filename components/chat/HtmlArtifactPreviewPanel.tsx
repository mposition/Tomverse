"use client";

import { createApiClient } from "@tomverse/api-client";
import { Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useLanguage } from "@/components/LanguageProvider";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { artifactDownloadPath, type ChatStreamArtifact } from "@/lib/generatedArtifactCore";
import {
  HTML_PREVIEW_MAX_BYTES,
  HTML_PREVIEW_SANDBOX,
  buildHtmlPreviewSrcdoc,
  isHtmlPreviewSmallEnough,
  withEmbedderNonce,
} from "@/lib/htmlArtifactPreview";

/**
 * The side panel (desktop) or full-screen sheet (phone) that runs a generated
 * HTML page in an isolated frame.
 *
 * Policy: docs/policy/generated-artifacts.md section 9. The isolation itself
 * (sandbox tokens, CSP, srcdoc) is `lib/htmlArtifactPreview.ts`; this file is
 * the frame, the fetch and the panel around it.
 *
 * The file is fetched through the same authenticated download route as the
 * download button, so ownership, the conversation lock and the rate limit are
 * that route's, unchanged. Nothing here reads a file by any other path.
 */

/** A srcdoc frame fires `load` once. A second load means the page navigated its own frame away. */
export const frameLeftItsDocument = (loadCount: number) => loadCount > 1;

/** The frame alone: no network, no portal, so it renders anywhere. */
export function HtmlArtifactPreviewFrame({ html, title, onLeft }: { html: string; title: string; onLeft?: () => void }) {
  const srcDoc = useMemo(() => {
    // The embedding document's CSP nonce, if it has one (see withEmbedderNonce).
    const nonce = typeof document === "undefined" ? null : document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
    const page = typeof DOMParser === "undefined" ? html : withEmbedderNonce(html, nonce, (text) => new DOMParser().parseFromString(text, "text/html"));
    return buildHtmlPreviewSrcdoc(page);
  }, [html]);
  const loads = useRef(0);
  return (
    <iframe
      data-testid="html-artifact-preview-frame"
      title={title}
      sandbox={HTML_PREVIEW_SANDBOX}
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      allow=""
      className="h-full w-full flex-1 border-0 bg-white"
      onLoad={() => {
        loads.current += 1;
        if (frameLeftItsDocument(loads.current)) onLeft?.();
      }}
    />
  );
}

type Loaded =
  | { status: "loading" }
  | { status: "ready"; html: string }
  | { status: "failed"; message: string }
  | { status: "too_large" };

export function HtmlArtifactPreviewPanel({ artifact, onClose }: { artifact: ChatStreamArtifact; onClose: () => void }) {
  const { t } = useLanguage();
  const [loaded, setLoaded] = useState<Loaded>(
    isHtmlPreviewSmallEnough(artifact.byteSize) ? { status: "loading" } : { status: "too_large" }
  );
  const [left, setLeft] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

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
        if (bytes.byteLength > HTML_PREVIEW_MAX_BYTES) setLoaded({ status: "too_large" });
        else setLoaded({ status: "ready", html: new TextDecoder("utf-8").decode(bytes) });
      } catch {
        if (!cancelled) setLoaded({ status: "failed", message: t("chat.artifactPreviewFailed") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifact.byteSize, artifact.id, t]);

  // Keyboard: Escape closes; focus moves in on open and returns to the opener on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [onClose]);

  const title = t("chat.artifactPreviewAlt").replaceAll("{filename}", artifact.filename);
  const notice =
    left ? t("chat.artifactPreviewNavigationBlocked")
    : loaded.status === "failed" ? loaded.message
    : loaded.status === "too_large" ? t("chat.artifactPreviewTooLarge")
    : null;

  return createPortal(
    <div
      role="dialog"
      aria-label={title}
      data-testid="html-artifact-preview-panel"
      // Phone: a full-screen sheet. md and up: a panel on the right edge.
      className="fixed inset-0 z-50 flex flex-col bg-white shadow-xl dark:bg-zinc-950 md:left-auto md:w-[min(560px,46vw)] md:border-l md:border-zinc-200 md:dark:border-zinc-700"
    >
      <header className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-700">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-zinc-800 dark:text-zinc-100" title={artifact.filename}>{artifact.filename}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("chat.artifactPreviewSandboxNote")}</p>
        </div>
        <button
          ref={closeRef}
          type="button"
          data-testid="html-artifact-preview-close"
          onClick={onClose}
          aria-label={t("chat.artifactPreviewClose")}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-generated-artifact-500 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <X className="h-5 w-5" />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {notice ? (
          <p role="alert" data-testid="html-artifact-preview-notice" className="p-4 text-sm text-zinc-600 dark:text-zinc-300">{notice}</p>
        ) : loaded.status === "loading" ? (
          <p role="status" className="flex items-center gap-2 p-4 text-sm text-zinc-500 dark:text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            {t("chat.artifactPreviewLoading")}
          </p>
        ) : loaded.status === "ready" ? (
          <HtmlArtifactPreviewFrame html={loaded.html} title={title} onLeft={() => setLeft(true)} />
        ) : null}
      </div>
    </div>,
    document.body
  );
}
