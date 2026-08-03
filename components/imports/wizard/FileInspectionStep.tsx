"use client";

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, FileArchive, Loader2, MonitorSmartphone } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    interpolate,
    primaryButtonClass,
    secondaryButtonClass,
} from "@/components/imports/importFormatting";
import type { ExternalImportWizardStatus } from "@/lib/externalImportWizard";

/**
 * Step 2 — choosing the export file and watching it be read.
 *
 * Everything here happens on the device: the file input hands a `File` to the
 * Web Worker and the worker posts progress back. Nothing is uploaded in this
 * step, which is exactly what the desktop-recommended state has to say out
 * loud when a device cannot cope with the archive.
 *
 * Parsing progress goes through a polite live region rather than a toast, so
 * a screen-reader user hears it without losing their place.
 */
export function FileInspectionStep({
    status,
    onFileSelected,
    onCancelParsing,
    onBack,
    onRetry,
}: {
    status: Extract<
        ExternalImportWizardStatus,
        | { kind: "file_selection" }
        | { kind: "parsing" }
        | { kind: "parse_failed" }
        | { kind: "desktop_recommended" }
    >;
    onFileSelected: (file: File) => void;
    onCancelParsing: () => void;
    onBack: () => void;
    onRetry: () => void;
}) {
    const { t } = useLanguage();
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [dragActive, setDragActive] = useState(false);
    const [showDiagnostics, setShowDiagnostics] = useState(false);

    const handleDrop = useCallback(
        (event: React.DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            setDragActive(false);
            const file = event.dataTransfer.files?.[0];
            if (file) onFileSelected(file);
        },
        [onFileSelected]
    );

    if (status.kind === "desktop_recommended") {
        return (
            <div data-testid="external-import-desktop-recommended">
                <div className="flex items-start gap-3">
                    <MonitorSmartphone className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                    <div>
                        <h2 className="text-base font-bold">
                            {t("externalImport.desktopRecommendedTitle")}
                        </h2>
                        <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                            {t("externalImport.desktopRecommended")}
                        </p>
                        <ul className="mt-2 grid gap-1 text-sm leading-6 text-zinc-500">
                            <li data-testid="external-import-desktop-no-upload">
                                {t("externalImport.desktopRecommendedNoUpload")}
                            </li>
                            <li data-testid="external-import-desktop-no-data">
                                {t("externalImport.desktopRecommendedNoData")}
                            </li>
                            <li>
                                {t("externalImport.desktopRecommendedRetry")}
                            </li>
                        </ul>
                    </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                    <button
                        type="button"
                        className={secondaryButtonClass}
                        onClick={onRetry}
                    >
                        {t("externalImport.selectFile")}
                    </button>
                    <button
                        type="button"
                        className={secondaryButtonClass}
                        data-testid="external-import-back-step"
                        onClick={onBack}
                    >
                        {t("externalImport.back")}
                    </button>
                </div>
            </div>
        );
    }

    if (status.kind === "parsing") {
        return (
            <div data-testid="external-import-parsing">
                <div className="flex items-center gap-2 text-sm font-semibold">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("externalImport.parsing")}
                </div>
                <p
                    className="mt-1 text-sm leading-6 text-zinc-500"
                    role="status"
                    aria-live="polite"
                >
                    {interpolate(t("externalImport.parsingProgress"), {
                        conversations: status.conversationsFound,
                    })}
                </p>
                <button
                    type="button"
                    className={`${secondaryButtonClass} mt-4`}
                    onClick={onCancelParsing}
                >
                    {t("externalImport.cancel")}
                </button>
            </div>
        );
    }

    if (status.kind === "parse_failed") {
        return (
            <div data-testid="external-import-parse-failed">
                <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                    <div>
                        <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                            {t("externalImport.parseFailed")}
                        </p>
                        {/* The worker's raw reason label is a diagnostic, not
                            product copy: it stays behind a disclosure so the
                            default screen speaks the user's language. */}
                        <button
                            type="button"
                            className="mt-2 text-xs font-semibold text-zinc-500 underline"
                            aria-expanded={showDiagnostics}
                            data-testid="external-import-diagnostics-toggle"
                            onClick={() => setShowDiagnostics((open) => !open)}
                        >
                            {t("externalImport.diagnosticsToggle")}
                        </button>
                        {showDiagnostics && (
                            <p
                                className="mt-1 font-mono text-xs text-zinc-400"
                                data-testid="external-import-diagnostics"
                            >
                                {status.reason}
                            </p>
                        )}
                    </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                    <button
                        type="button"
                        className={secondaryButtonClass}
                        onClick={onRetry}
                    >
                        {t("externalImport.selectFile")}
                    </button>
                    <button
                        type="button"
                        className={secondaryButtonClass}
                        data-testid="external-import-back-step"
                        onClick={onBack}
                    >
                        {t("externalImport.back")}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div data-testid="external-import-file-selection">
            <h2 className="text-base font-bold">
                {t("externalImport.selectFile")}
            </h2>
            <p className="mt-1 text-sm leading-6 text-zinc-500">
                {t("externalImport.selectFileHint")}
            </p>
            <div
                onDragOver={(event) => {
                    event.preventDefault();
                    setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                className={`mt-4 rounded-2xl border-2 border-dashed px-4 py-8 text-center ${
                    dragActive
                        ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                        : "border-zinc-300 dark:border-zinc-700"
                }`}
                data-testid="external-import-dropzone"
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".zip,.json,application/zip,application/json"
                    className="sr-only"
                    data-testid="external-import-file-input"
                    onChange={(event) => {
                        const file = event.target.files?.[0] ?? null;
                        if (file) onFileSelected(file);
                        event.target.value = "";
                    }}
                />
                <button
                    type="button"
                    className={primaryButtonClass}
                    data-testid="external-import-choose-file"
                    onClick={() => fileInputRef.current?.click()}
                >
                    <FileArchive className="h-4 w-4" />
                    {t("externalImport.selectFile")}
                </button>
                <p className="mt-2 text-xs leading-5 text-zinc-500">
                    {t("externalImport.guideStaysLocal")}
                </p>
            </div>
            <button
                type="button"
                className={`${secondaryButtonClass} mt-4`}
                data-testid="external-import-back-step"
                onClick={onBack}
            >
                {t("externalImport.back")}
            </button>
        </div>
    );
}
