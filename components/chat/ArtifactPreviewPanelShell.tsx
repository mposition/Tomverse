"use client";

import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useLanguage } from "@/components/LanguageProvider";

/**
 * The side panel (desktop) or full-screen sheet (phone) around an isolated
 * preview frame: header, close, focus handling, and the optional "change this
 * screen" box. Shared by the generated-file preview and the in-answer code
 * preview, so the two cannot drift apart.
 *
 * Policy: docs/policy/generated-artifacts.md section 9. The isolation is the
 * frame's (lib/htmlArtifactPreview.ts); this is only the chrome.
 */

/**
 * One line under the preview: what to change, then "add to message". It sends
 * nothing itself. `onSubmit` puts the request in the composer (the file path
 * attaches a copy of the file and says what to change; the code path writes
 * "in the code above") and answers an error sentence, or null when it worked --
 * which closes the panel so the composer is what the user sees.
 */
function PreviewReviseForm({ onSubmit, onDone }: { onSubmit: (request: string) => Promise<string | null>; onDone: () => void }) {
  const { t } = useLanguage();
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = request.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const failure = await onSubmit(text);
      if (failure) setError(failure);
      else onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      data-testid="artifact-preview-revise"
      className="border-t border-zinc-200 p-3 dark:border-zinc-700"
    >
      <label htmlFor="artifact-preview-revise-input" className="text-xs font-bold text-zinc-600 dark:text-zinc-300">
        {t("chat.artifactWorkspaceReviseLabel")}
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id="artifact-preview-revise-input"
          data-testid="artifact-preview-revise-input"
          type="text"
          value={request}
          maxLength={500}
          onChange={(event) => setRequest(event.target.value)}
          placeholder={t("chat.artifactWorkspaceRevisePlaceholder")}
          // 16px keeps iOS from zooming the page when the field is focused.
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 text-base text-zinc-900 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-generated-artifact-500 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
        />
        <button
          type="submit"
          data-testid="artifact-preview-revise-submit"
          disabled={busy || !request.trim()}
          className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-accent-generated-artifact-600 px-3 text-sm font-bold text-white hover:bg-accent-generated-artifact-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-generated-artifact-500 focus-visible:ring-offset-2 disabled:opacity-60 dark:focus-visible:ring-offset-zinc-950"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
          {t("chat.artifactWorkspaceReviseSubmit")}
        </button>
      </div>
      {error && (
        <p role="alert" data-testid="artifact-preview-revise-error" className="mt-1 text-xs font-semibold text-red-600 dark:text-red-300">
          {error}
        </p>
      )}
    </form>
  );
}

export function ArtifactPreviewPanelShell({
  title,
  heading,
  onClose,
  onRevise,
  children,
}: {
  /** The accessible name of the dialog. */
  title: string;
  /** The visible heading: a file name, or the kind of code. */
  heading: string;
  onClose: () => void;
  /** Present only when the user may ask for a change from here. */
  onRevise?: (request: string) => Promise<string | null>;
  children: ReactNode;
}) {
  const { t } = useLanguage();
  const closeRef = useRef<HTMLButtonElement>(null);

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
          <p className="truncate text-sm font-bold text-zinc-800 dark:text-zinc-100" title={heading}>{heading}</p>
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
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {onRevise && <PreviewReviseForm onSubmit={onRevise} onDone={onClose} />}
    </div>,
    document.body
  );
}
