"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Braces,
  Download,
  FileArchive,
  FileCode,
  FileText,
  FileType,
  Loader2,
  Lock,
  Presentation,
  RotateCcw,
  Sheet,
  Table,
  type LucideIcon,
} from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import {
  artifactDownloadPath,
  artifactFormat,
  formatArtifactSize,
  visibleGeneratedArtifacts,
  type ArtifactFailureCode,
  type ArtifactLabelGroup,
  type ChatStreamArtifact,
} from "@/lib/generatedArtifactCore";
import { saveResponseAsFile } from "@/lib/browserDownload";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * The download card for a file an answer produced.
 *
 * Policy: docs/policy/generated-artifacts.md section 9.
 *
 * Three states, and the second two are the reason this is a component rather
 * than a button:
 *
 *   * **ready** -- a real file, with its own download.
 *   * **failed** -- the generation did not produce one. The card says so and
 *     offers to try again. The *message* is not an error: the answer around it
 *     is real, and failing the whole turn because a spreadsheet did not build
 *     would throw away an answer the user paid for.
 *   * **blocked** -- file generation needs an account. A sign-in call to
 *     action, shown up front, because the alternative the product refuses to
 *     ship is a Python snippet pretending to be a result.
 *
 * The download goes through `fetch` and a blob rather than navigation. A
 * navigation hands the whole outcome to the browser, failures included -- a
 * 404 or a 500 becomes a JSON error page the visitor is navigated to, with the
 * conversation gone. See lib/browserDownload.ts.
 */

const interpolateCopy = (
  template: string,
  values: Record<string, string | number>
) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );

/**
 * The card's name and icon for each label group.
 *
 * Grouped rather than per format, for the reason `ARTIFACT_LABEL_GROUPS` is
 * grouped: eleven translated names cover fifty-eight formats, and the four
 * generic ones fill the extension in themselves so a `.rs` file still says
 * "RS" on the card rather than "source file".
 */
const LABEL_GROUP_COPY: Readonly<
  Record<ArtifactLabelGroup, { key: string; icon: LucideIcon }>
> = {
  xlsx: { key: "chat.artifactTypeXlsx", icon: Sheet },
  csv: { key: "chat.artifactTypeCsv", icon: Table },
  docx: { key: "chat.artifactTypeDocx", icon: FileText },
  pdf: { key: "chat.artifactTypePdf", icon: FileType },
  pptx: { key: "chat.artifactTypePptx", icon: Presentation },
  markdown: { key: "chat.artifactTypeMarkdown", icon: FileText },
  text: { key: "chat.artifactTypeText", icon: FileText },
  data: { key: "chat.artifactTypeData", icon: Braces },
  markup: { key: "chat.artifactTypeMarkup", icon: FileCode },
  code: { key: "chat.artifactTypeCode", icon: FileCode },
  archive: { key: "chat.artifactTypeArchive", icon: FileArchive },
};

const FAILURE_COPY_KEYS: Readonly<Record<ArtifactFailureCode, string>> = {
  sign_in_required: "chat.artifactSignInDescription",
  generation_failed: "chat.artifactFailedGeneration",
  storage_failed: "chat.artifactFailedStorage",
  spec_rejected: "chat.artifactFailedSpec",
  format_unsupported: "chat.artifactFailedFormat",
  limit_exceeded: "chat.artifactFailedLimit",
  turn_incomplete: "chat.artifactFailedIncomplete",
};

type GeneratedArtifactCardProps = {
  artifact: ChatStreamArtifact;
  /**
   * Turns a model id into its catalogue name.
   *
   * The id comes from the artifact itself wherever it has one, not from the
   * message: a hard fallback answers on a different model from the one the
   * panel is labelled with, and the file belongs to whichever model actually
   * produced it.
   */
  modelNameFor?: (modelId: string) => string;
  /** The panel's own model, for an artifact that names none. */
  fallbackModelId?: string | null;
  /** Re-sends the prompt that produced this answer. */
  onRetry?: () => void;
  /** Guests get the sign-in call to action instead of a download. */
  isGuestMode?: boolean;
};

export function GeneratedArtifactCard({
  artifact,
  modelNameFor,
  fallbackModelId,
  onRetry,
  isGuestMode,
}: GeneratedArtifactCardProps) {
  const { t } = useLanguage();
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const attributedModelId = artifact.modelId ?? fallbackModelId ?? null;
  const modelName = attributedModelId
    ? (modelNameFor?.(attributedModelId) ?? attributedModelId)
    : null;
  /*
    An artifact's format arrives over the wire, so it is looked up rather than
    indexed: a transcript written by a newer server can name a format this
    build has never heard of, and a card that throws would take the whole
    answer with it.
  */
  const descriptor = artifactFormat(artifact.format);
  const group = LABEL_GROUP_COPY[descriptor?.labelGroup ?? "text"];
  const typeLabel = interpolateCopy(t(group.key), {
    ext: artifact.format.toUpperCase(),
  });
  const FormatIcon = group.icon;
  const sizeLabel = formatArtifactSize(artifact.byteSize);

  const download = useCallback(async () => {
    setIsDownloading(true);
    setDownloadError(null);
    try {
      const response = await fetch(artifactDownloadPath(artifact.id), {
        cache: "no-store",
      });
      if (!response.ok) {
        await discardResponseBody(response);
        // A locked conversation is the one failure the user can act on, so it
        // gets its own sentence rather than the generic one.
        setDownloadError(
          response.status === 423
            ? t("chat.artifactDownloadLocked")
            : t("chat.artifactDownloadFailed")
        );
        return;
      }
      await saveResponseAsFile(response, artifact.filename);
    } catch {
      setDownloadError(t("chat.artifactDownloadFailed"));
    } finally {
      setIsDownloading(false);
    }
  }, [artifact.filename, artifact.id, t]);

  const isReady = artifact.status === "ready";
  const isBlocked = artifact.status === "blocked";

  /*
    One accessible name carrying everything the card says visually: the
    format, the file name, the size and the state. A screen reader reaching
    this card gets the same four facts a sighted reader gets from the icon,
    the title, the meta line and the button -- without having to walk them.
  */
  const accessibleName = isReady
    ? interpolateCopy(t("chat.artifactReadyLabel"), {
        type: typeLabel,
        filename: artifact.filename,
        size: sizeLabel,
      })
    : isBlocked
      ? interpolateCopy(t("chat.artifactBlockedLabel"), {
          type: typeLabel,
        })
      : interpolateCopy(t("chat.artifactFailedLabel"), {
          type: typeLabel,
          filename: artifact.filename,
        });

  const failureText = artifact.failureCode
    ? t(FAILURE_COPY_KEYS[artifact.failureCode])
    : t("chat.artifactFailedGeneration");

  return (
    <li
      data-testid="generated-artifact-card"
      data-artifact-status={artifact.status}
      data-artifact-format={artifact.format}
      data-artifact-model={attributedModelId ?? ""}
      /*
        `flex-col` first and the row layout second, so the narrow case is the
        one that is written down rather than the one that is hoped for: the
        name and the button occupy separate full-width rows and cannot
        overlap. `min-w-0` on the text column is what actually lets `truncate`
        work -- a flex child's default `min-width: auto` refuses to shrink
        below its content, and a long file name would push the button off the
        card instead of ellipsising.

        The row layout is keyed to `@md/artifacts` -- the width of the list
        this card sits in -- and not to `sm:`, the width of the window. A
        1440px desktop renders three model panels side by side, and inside one
        of those the card's own content box is around 300px: the viewport
        variant matched there anyway, laid the card out in one row, and left
        the failure sentence a few characters wide wrapping down the card. A
        card cannot query its own size, so the container is the `<ul>` in
        `GeneratedArtifactList`; with no such ancestor these variants never
        match and the card stays in its stacked layout, which is the safe way
        round. See components/analytics/AnalyticsProvider.tsx for the same
        move on the consent notice.

        28rem is where a row actually fits: 40px of icon, two 12px gaps and a
        control that runs to ~150px in the longest locale still leave the text
        column over 200px. `flex-wrap` is the last resort under that -- a
        locale whose label outgrows the budget wraps the control onto its own
        line instead of crushing the sentence beside it.
      */
      className={`flex flex-col gap-3 rounded-xl border p-3 @md/artifacts:flex-row @md/artifacts:flex-wrap @md/artifacts:items-center ${
        isReady
          ? "border-accent-generated-artifact-200 bg-accent-generated-artifact-50/60 dark:border-accent-generated-artifact-800 dark:bg-accent-generated-artifact-950/40"
          : isBlocked
            ? "border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900"
            : "border-amber-200 bg-amber-50 dark:border-amber-800/70 dark:bg-amber-950/30"
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
          isReady
            ? "bg-accent-generated-artifact-600 text-white"
            : isBlocked
              ? "bg-zinc-300 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
              : "bg-amber-500 text-white"
        }`}
      >
        {isReady ? (
          <FormatIcon className="h-5 w-5" />
        ) : isBlocked ? (
          <Lock className="h-5 w-5" />
        ) : (
          <AlertTriangle className="h-5 w-5" />
        )}
      </span>

      {/*
        `min-w-0` keeps `truncate` working; the container-scoped minimum keeps
        the column readable once the card is in its row layout, so a long
        control can never squeeze the failure sentence into a vertical ribbon
        of single characters.
      */}
      <div className="min-w-0 flex-1 @md/artifacts:min-w-[10rem]">
        <p
          data-testid="generated-artifact-filename"
          className="truncate text-sm font-bold text-zinc-800 dark:text-zinc-100"
          title={artifact.filename}
        >
          {isBlocked ? t("chat.artifactSignInTitle") : artifact.filename}
        </p>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {isReady ? (
            <span data-testid="generated-artifact-meta">
              {typeLabel}
              {" · "}
              {sizeLabel}
              {modelName ? ` · ${modelName}` : ""}
            </span>
          ) : isBlocked ? (
            t("chat.artifactSignInDescription")
          ) : (
            <span data-testid="generated-artifact-failure">{failureText}</span>
          )}
        </p>
        {downloadError && (
          <p
            data-testid="generated-artifact-download-error"
            role="alert"
            className="mt-1 text-xs font-semibold text-red-600 dark:text-red-300"
          >
            {downloadError}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {isReady && (
          <button
            type="button"
            data-testid="generated-artifact-download"
            onClick={() => void download()}
            disabled={isDownloading}
            aria-label={accessibleName}
            /*
              `min-h-11` is the 44px touch target, and it is on the control
              rather than on a wrapper so the target and the hit area are the
              same rectangle. The focus ring is `focus-visible` so a pointer
              user never sees it and a keyboard user always does.
            */
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent-generated-artifact-600 px-4 text-sm font-bold text-white transition hover:bg-accent-generated-artifact-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-generated-artifact-500 focus-visible:ring-offset-2 disabled:opacity-60 @md/artifacts:w-auto dark:focus-visible:ring-offset-zinc-900"
          >
            {isDownloading ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {t("chat.artifactDownload")}
          </button>
        )}
        {isBlocked && (
          <Link
            href={`/auth/signin?callbackUrl=${encodeURIComponent("/chat")}`}
            data-testid="generated-artifact-signin"
            className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-blue-600 px-4 text-sm font-bold text-white transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 @md/artifacts:w-auto dark:focus-visible:ring-offset-zinc-900"
          >
            {t("chat.artifactSignInCta")}
          </Link>
        )}
        {!isReady && !isBlocked && onRetry && !isGuestMode && (
          <button
            type="button"
            data-testid="generated-artifact-retry"
            onClick={onRetry}
            aria-label={accessibleName}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-amber-300 bg-white px-4 text-sm font-bold text-amber-800 transition hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 @md/artifacts:w-auto dark:border-amber-700 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-900/40 dark:focus-visible:ring-offset-zinc-900"
          >
            <RotateCcw className="h-4 w-4" />
            {t("chat.artifactRetry")}
          </button>
        )}
      </div>
    </li>
  );
}

type GeneratedArtifactListProps = {
  artifacts: ChatStreamArtifact[];
  modelNameFor?: (modelId: string) => string;
  fallbackModelId?: string | null;
  onRetry?: () => void;
  isGuestMode?: boolean;
};

/** The whole section, or nothing when the answer produced no file. */
export function GeneratedArtifactList({
  artifacts,
  modelNameFor,
  fallbackModelId,
  onRetry,
  isGuestMode,
}: GeneratedArtifactListProps) {
  const { t } = useLanguage();
  /*
    A turn that failed once and then fixed itself shows the file, not both the
    file and the apology for it. The rows stay in the database either way --
    this is a presentation rule, and the whole of it is in
    `visibleGeneratedArtifacts`, so the streamed trailer and the reloaded
    conversation reach the same answer from the same input.
  */
  const visible = visibleGeneratedArtifacts(artifacts, { fallbackModelId });
  if (!visible.length) return null;
  return (
    <section
      data-testid="generated-artifact-section"
      aria-label={t("chat.artifactSectionLabel")}
      className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-700/60"
    >
      <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
        {t("chat.artifactSectionLabel")}
      </p>
      {/*
        The query container for every card below. It is the list rather than
        the card because an element cannot query its own size, and the list is
        exactly as wide as the cards are -- which is the width that decides
        whether a card's icon, text and control fit on one row. The viewport
        does not decide that: a model panel inside a 1440px window is about
        300px wide.
      */}
      <ul className="space-y-2 @container/artifacts">
        {visible.map((artifact) => (
          <GeneratedArtifactCard
            key={`${artifact.id}-${artifact.ordinal}`}
            artifact={artifact}
            modelNameFor={modelNameFor}
            fallbackModelId={fallbackModelId}
            onRetry={onRetry}
            isGuestMode={isGuestMode}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * The placeholder shown while the tool is still running.
 *
 * A separate component rather than a fourth `status`, because it describes the
 * request rather than a result: there is no artifact yet, no id, no size and
 * nothing to download. Naming the format in the label -- "Creating the Excel
 * workbook" -- is what makes the wait legible; a bare spinner beside a
 * streaming answer says nothing about which of the two is slow. A signal that
 * did not carry a readable format still gets a spinner, without a name.
 */
export function GeneratedArtifactPending({ format }: { format?: string }) {
  const { t } = useLanguage();
  const descriptor = format ? artifactFormat(format) : undefined;
  const typeLabel = descriptor
    ? interpolateCopy(t(LABEL_GROUP_COPY[descriptor.labelGroup].key), {
        ext: descriptor.id.toUpperCase(),
      })
    : null;
  return (
    <section
      data-testid="generated-artifact-pending"
      aria-label={t("chat.artifactSectionLabel")}
      className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-700/60"
    >
      <p
        role="status"
        className="flex items-center gap-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400"
      >
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        {typeLabel
          ? interpolateCopy(t("chat.artifactGeneratingNamed"), {
              type: typeLabel,
            })
          : t("chat.artifactGenerating")}
      </p>
    </section>
  );
}
