"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Download, Loader2, Lock, RotateCcw, Sheet } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import {
  artifactDownloadPath,
  formatArtifactSize,
  type ArtifactFailureCode,
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
  const typeLabel =
    artifact.format === "csv"
      ? t("chat.artifactTypeCsv")
      : t("chat.artifactTypeXlsx");
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
        `flex-col` first and `sm:flex-row` second, so the 320px case is the
        one that is written down rather than the one that is hoped for: the
        name and the button occupy separate full-width rows and cannot
        overlap. `min-w-0` on the text column is what actually lets `truncate`
        work -- a flex child's default `min-width: auto` refuses to shrink
        below its content, and a long file name would push the button off the
        card instead of ellipsising.
      */
      className={`flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center ${
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
          <Sheet className="h-5 w-5" />
        ) : isBlocked ? (
          <Lock className="h-5 w-5" />
        ) : (
          <AlertTriangle className="h-5 w-5" />
        )}
      </span>

      <div className="min-w-0 flex-1">
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
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent-generated-artifact-600 px-4 text-sm font-bold text-white transition hover:bg-accent-generated-artifact-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-generated-artifact-500 focus-visible:ring-offset-2 disabled:opacity-60 sm:w-auto dark:focus-visible:ring-offset-zinc-900"
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
            className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-blue-600 px-4 text-sm font-bold text-white transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 sm:w-auto dark:focus-visible:ring-offset-zinc-900"
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
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-amber-300 bg-white px-4 text-sm font-bold text-amber-800 transition hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 sm:w-auto dark:border-amber-700 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-900/40 dark:focus-visible:ring-offset-zinc-900"
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
  if (!artifacts.length) return null;
  return (
    <section
      data-testid="generated-artifact-section"
      aria-label={t("chat.artifactSectionLabel")}
      className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-700/60"
    >
      <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
        {t("chat.artifactSectionLabel")}
      </p>
      <ul className="space-y-2">
        {artifacts.map((artifact) => (
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
 * file" -- is what makes the wait legible; a bare spinner beside a streaming
 * answer says nothing about which of the two is slow.
 */
export function GeneratedArtifactPending() {
  const { t } = useLanguage();
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
        {t("chat.artifactGenerating")}
      </p>
    </section>
  );
}
