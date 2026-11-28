"use client";

import { Copy, Download, RotateCcw, SendHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { HtmlArtifactPreviewFrame, usePreviewDocumentLabels } from "@/components/chat/HtmlArtifactPreviewFrame";
import { useLanguage } from "@/components/LanguageProvider";
import {
  ARTIFACT_EDIT_RENDER_DELAY_MS,
  continueWithVersionText,
  editedDownload,
  editedVersionKey,
  keepEditedVersion,
  readEditedVersion,
} from "@/lib/artifactPreviewEditing";
import { saveBlobAsFile } from "@/lib/browserDownload";
import { buildCodePreviewDocument, type CodePreviewKind } from "@/lib/chatArtifactPreview";
import { artifactWorkspaceCopy } from "@/locales/artifactWorkspace";

/**
 * The body of the preview panel: the isolated frame, and -- with the artifact
 * workspace switch on -- a code tab where the person edits the source and sees
 * the preview redrawn.
 *
 * Policy: docs/policy/generated-artifacts.md section 9, "패널 안에서 직접
 * 고치기". An edit is the person's own text and changes nothing about how it
 * runs: every version, original or edited, is turned into a page by
 * `buildCodePreviewDocument` and shown by `HtmlArtifactPreviewFrame`, the same
 * sandbox, CSP, nested frame and size limit as before. Edits stay in this page
 * (lib/artifactPreviewEditing.ts) and are never written to the conversation.
 */

export type EditablePreviewSource = {
  kind: CodePreviewKind;
  /** The fence tag or file format: html, htm, svg, jsx, tsx. */
  language: string;
  /** The text as the answer wrote it. */
  original: string;
  /** A generated file's id, when the source is one. */
  artifactId?: string | null;
  /** A generated file's name, for the download. */
  filename?: string | null;
};

type Mode = "preview" | "code";

const toolbarButton =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-bold text-zinc-700 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-generated-artifact-500 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800";

export function ArtifactPreviewWorkspace({
  source,
  title,
  editable,
  fillComposer,
  onClose,
  shareControl,
}: {
  source: EditablePreviewSource;
  /** The frame's accessible name. */
  title: string;
  /** The artifact workspace switch: the code tab and its buttons exist only when it is on. */
  editable: boolean;
  /** Puts text in the composer; null where there is no composer. */
  fillComposer: ((text: string) => void) | null;
  onClose: () => void;
  /** The share button, when sharing applies to this source. */
  shareControl?: ReactNode;
}) {
  const { t, lang } = useLanguage();
  const copy = artifactWorkspaceCopy[lang].edit;
  const labels = usePreviewDocumentLabels();
  const key = editedVersionKey(source);
  const [mode, setMode] = useState<Mode>("preview");
  const [draft, setDraft] = useState(() => (editable ? readEditedVersion(key) ?? source.original : source.original));
  // The text the frame shows. It follows `draft` only after a pause, so typing does not reload the frame on every key.
  const [rendered, setRendered] = useState(draft);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edited = editable && draft !== source.original;

  useEffect(() => {
    if (rendered === draft) return;
    const timer = setTimeout(() => setRendered(draft), ARTIFACT_EDIT_RENDER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, rendered]);

  useEffect(() => {
    if (editable) keepEditedVersion(key, draft, source.original);
  }, [editable, key, draft, source.original]);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const built = useMemo(
    () => buildCodePreviewDocument(source.kind, rendered, {
      language: source.language,
      labels,
      assetOrigin: typeof window === "undefined" ? "" : window.location.origin,
    }),
    [source.kind, source.language, rendered, labels]
  );

  const flash = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2500);
  };

  const showMode = (next: Mode) => {
    // Leaving the editor shows exactly what was typed, without waiting for the pause.
    if (next === "preview") setRendered(draft);
    setMode(next);
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      flash(copy.copied);
    } catch {
      flash(copy.copyFailed);
    }
  };

  const download = () => {
    const file = editedDownload({ kind: source.kind, language: source.language, filename: source.filename });
    saveBlobAsFile(new Blob([draft], { type: file.mediaType }), file.filename);
  };

  const continueWithVersion = () => {
    if (!fillComposer) return;
    const text = continueWithVersionText(copy.continuePrompt, { kind: source.kind, language: source.language, code: draft });
    if (!text) {
      flash(copy.continueTooLong);
      return;
    }
    fillComposer(text);
    onClose();
  };

  const frame = built.ok ? (
    <HtmlArtifactPreviewFrame html={built.html} title={title} />
  ) : (
    <p role="alert" data-testid="html-artifact-preview-notice" className="p-4 text-sm text-zinc-600 dark:text-zinc-300">
      {t(built.reason === "too_large" ? "chat.artifactWorkspaceCodeTooLarge" : "chat.artifactWorkspaceCodeEmpty")}
    </p>
  );

  const toolbar = editable || shareControl;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="artifact-preview-workspace">
      {toolbar && (
        <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 px-2 py-1 dark:border-zinc-700">
          {editable && (
            <div role="tablist" aria-label={copy.tabsLabel} className="flex items-center gap-1">
              {(["preview", "code"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={mode === value}
                  data-testid={`artifact-preview-tab-${value}`}
                  onClick={() => showMode(value)}
                  className={`${toolbarButton} ${mode === value ? "bg-zinc-100 text-zinc-950 dark:bg-zinc-800 dark:text-white" : ""}`}
                >
                  {value === "preview" ? copy.tabPreview : copy.tabCode}
                </button>
              ))}
            </div>
          )}
          {edited && (
            <span data-testid="artifact-preview-edited" className="rounded-md bg-accent-generated-artifact-100 px-2 py-0.5 text-[11px] font-bold text-accent-generated-artifact-800 dark:bg-accent-generated-artifact-900/60 dark:text-accent-generated-artifact-100">
              {copy.edited}
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {edited && (
              <button type="button" data-testid="artifact-preview-reset" onClick={() => setDraft(source.original)} className={toolbarButton}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {copy.reset}
              </button>
            )}
            {editable && (
              <>
                <button type="button" data-testid="artifact-preview-copy" onClick={() => void copyCode()} className={toolbarButton}>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  {copy.copy}
                </button>
                <button type="button" data-testid="artifact-preview-download" onClick={download} className={toolbarButton}>
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  {copy.download}
                </button>
              </>
            )}
            {edited && fillComposer && (
              <button type="button" data-testid="artifact-preview-continue" onClick={continueWithVersion} className={toolbarButton}>
                <SendHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                {copy.continue}
              </button>
            )}
            {shareControl}
          </div>
        </div>
      )}
      {notice && (
        <p role="status" data-testid="artifact-preview-workspace-notice" className="border-b border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
          {notice}
        </p>
      )}
      {editable && mode === "code" ? (
        // Code above, the live preview below: the person sees what an edit does without leaving the editor.
        <div className="grid min-h-0 flex-1 grid-rows-2">
          <textarea
            data-testid="artifact-preview-code"
            aria-label={copy.codeLabel}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            // 16px on phones keeps iOS from zooming the page when the field is focused.
            className="min-h-0 w-full resize-none overflow-auto border-0 border-b border-zinc-200 bg-zinc-950 p-3 font-mono text-base leading-relaxed text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-generated-artifact-500 md:text-[13px] dark:border-zinc-700"
          />
          <section aria-label={copy.livePreviewLabel} className="flex min-h-0 flex-col">{frame}</section>
        </div>
      ) : (
        frame
      )}
    </div>
  );
}
