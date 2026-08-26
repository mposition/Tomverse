"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, Trash2, Upload } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { assistantProfileErrorCopyKey } from "@/lib/assistantProfileErrorCopy";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * Adding, watching and removing an assistant's knowledge files (Release C).
 *
 * docs/policy/external-conversation-import-and-memory.md §14, §14.1.
 *
 * The server side of this shipped first and was verified against staging on
 * 2026-08-22 by calling the API by hand, because there was no way to add a
 * file from the product at all. Selection existed -- the editor already listed
 * files and wrote the chosen ids into a version manifest -- so what was
 * missing was the half that puts a file there to select.
 *
 * Two things decide the shape here.
 *
 * **The flag is answered by the endpoint, not by a prop.**
 * `isAssistantKnowledgeEnabled()` is the AND of the knowledge flag and the
 * profile flag, and only the server can evaluate it. So this panel asks for
 * the capacity it needs anyway and reads the refusal: 403 means the feature is
 * off and the panel renders nothing. A boolean threaded down from a page would
 * be a second copy of a decision that already has one home.
 *
 * **Capacity is read before a file is chosen, not after it is refused.**
 * §14.1 sets five ceilings and the byte ones bind first in practice. A picker
 * that only finds out on upload teaches the owner nothing about what is left,
 * and the refusal arrives after they have waited for the transfer.
 */

type KnowledgeFile = {
    id: string;
    name: string;
    processingStatus: string;
    chunkCount: number;
};

type ManifestEntry = { fileId: string; name: string };

type Capacity = {
    limits: {
        maxFileBytes: number;
        maxFilesPerProfile: number;
        maxFilesPerAccount: number;
        maxObjectBytesPerAccount: number;
        maxExtractedBytesPerAccount: number;
    };
    remaining: {
        filesInProfile: number;
        filesInAccount: number;
        objectBytes: number;
        extractedBytes: number;
    };
    acceptedMediaTypes: string[];
};

type UploadState =
    | { kind: "idle" }
    | { kind: "working" }
    | { kind: "refused"; code: string }
    | { kind: "failed" };

const megabytes = (bytes: number) => Math.floor(bytes / (1024 * 1024));

export function KnowledgeFilesPanel({
    profileId,
    knowledgeEnabled,
    files,
    publishedManifest,
    selectedFileIds,
    onToggleFile,
    onChanged,
}: {
    profileId: string;
    /**
     * Whether knowledge files are enabled, resolved on the server and handed
     * down (`settings/assistants/[profileId]/page.tsx`).
     *
     * This panel used to find out by calling its own endpoint and reading the
     * 403, which put a failed request in the console on every visit with the
     * flag off -- an error the reader did not cause and cannot act on. It also
     * meant the panel rendered for a moment before hiding itself.
     */
    knowledgeEnabled: boolean;
    files: KnowledgeFile[];
    /** The manifest of the revision that is currently published, if any. */
    publishedManifest: ManifestEntry[];
    selectedFileIds: string[];
    onToggleFile: (fileId: string, next: boolean) => void;
    /** Reload the profile: the file list and the manifest both move. */
    onChanged: () => void | Promise<void>;
}) {
    const { t } = useLanguage();
    const inputId = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const [capacity, setCapacity] = useState<Capacity | null>(null);
    // Seeded from the server's answer rather than from `null`: there is no
    // window in which the panel does not know. The 403 branch below stays as a
    // fallback, because the flag can be turned off between this page being
    // rendered and the capacity read landing.
    const [enabled, setEnabled] = useState<boolean>(knowledgeEnabled);
    const [upload, setUpload] = useState<UploadState>({ kind: "idle" });
    const [deletingId, setDeletingId] = useState<string | null>(null);

    const api = `/api/assistant-profiles/${profileId}/knowledge`;

    const readCapacity = useCallback(async () => {
        try {
            const response = await fetch(api, { cache: "no-store" });
            if (response.status === 403) {
                await discardResponseBody(response);
                setEnabled(false);
                return;
            }
            if (!response.ok) {
                await discardResponseBody(response);
                setEnabled(true);
                return;
            }
            const data = (await response.json()) as { capacity: Capacity };
            setEnabled(true);
            setCapacity(data.capacity);
        } catch {
            // A failed capacity read is not a refusal. Leave the panel up so
            // the owner can still see and deselect what is already there.
            setEnabled(true);
        }
    }, [api]);

    useEffect(() => {
        // Nothing to read when the feature is off: the only thing this request
        // could return is the 403 the server already told us about.
        if (!knowledgeEnabled) return;
        // Deferred the way the editor defers its own load: a state update
        // reachable synchronously from an effect is what
        // `react-hooks/set-state-in-effect` refuses.
        queueMicrotask(() => {
            void readCapacity();
        });
    }, [knowledgeEnabled, readCapacity]);

    const addFile = useCallback(
        async (file: File) => {
            setUpload({ kind: "working" });
            try {
                const prepared = await fetch(api, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        action: "prepare",
                        filename: file.name,
                        // A browser leaves this empty for types it does not
                        // recognise. The server refuses an empty one rather
                        // than guessing, so say so here instead of sending "".
                        mime: file.type || "application/octet-stream",
                        bytes: file.size,
                    }),
                });
                if (!prepared.ok) {
                    const body = (await prepared
                        .json()
                        .catch(() => null)) as { code?: string } | null;
                    setUpload({ kind: "refused", code: body?.code ?? "UNKNOWN" });
                    return;
                }
                const { uploadKey, uploadUrl, uploadHeaders } =
                    (await prepared.json()) as {
                        uploadKey: string;
                        uploadUrl: string;
                        uploadHeaders: Record<string, string>;
                    };

                const stored = await fetch(uploadUrl, {
                    method: "PUT",
                    headers: uploadHeaders,
                    body: file,
                });
                if (!stored.ok) {
                    await discardResponseBody(stored);
                    // The object never landed, so there is no row to clean up:
                    // the abandoned-object sweep takes the key after its TTL.
                    setUpload({ kind: "failed" });
                    return;
                }

                const finalized = await fetch(api, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        action: "finalize",
                        uploadKey,
                        filename: file.name,
                        mime: file.type || "application/octet-stream",
                    }),
                });
                if (!finalized.ok) {
                    const body = (await finalized
                        .json()
                        .catch(() => null)) as { code?: string } | null;
                    setUpload({ kind: "refused", code: body?.code ?? "UNKNOWN" });
                    return;
                }
                await discardResponseBody(finalized);
                setUpload({ kind: "idle" });
                await onChanged();
                await readCapacity();
            } catch {
                setUpload({ kind: "failed" });
            } finally {
                if (inputRef.current) inputRef.current.value = "";
            }
        },
        [api, onChanged, readCapacity]
    );

    const removeFile = useCallback(
        async (fileId: string) => {
            setDeletingId(fileId);
            try {
                const response = await fetch(`${api}/${fileId}`, { method: "DELETE" });
                await discardResponseBody(response);
                await onChanged();
                await readCapacity();
            } catch {
                setUpload({ kind: "failed" });
            } finally {
                setDeletingId(null);
            }
        },
        [api, onChanged, readCapacity]
    );

    if (!enabled) return null;

    // A manifest entry whose file is gone. §14 makes the manifest audit
    // metadata: it records what a published revision was given and cannot
    // bring a deleted file back, so the row says so rather than disappearing.
    const known = new Set(files.map((file) => file.id));
    const unavailable = publishedManifest.filter((entry) => !known.has(entry.fileId));

    return (
        <fieldset className="flex flex-col gap-3" data-testid="knowledge-panel">
            <legend className="text-sm font-semibold">
                {t("assistantProfiles.knowledgeLabel")}
            </legend>

            {capacity && (
                <p className="text-xs text-zinc-500" data-testid="knowledge-capacity">
                    {t("assistantProfiles.knowledgeRemaining")
                        .replace(
                            "{files}",
                            String(
                                Math.min(
                                    capacity.remaining.filesInProfile,
                                    capacity.remaining.filesInAccount
                                )
                            )
                        )
                        .replace(
                            "{megabytes}",
                            String(megabytes(capacity.remaining.objectBytes))
                        )
                        .replace(
                            "{maxMegabytes}",
                            String(megabytes(capacity.limits.maxFileBytes))
                        )}
                </p>
            )}

            <div className="flex flex-col gap-2">
                {files.map((file) => (
                    <div key={file.id} className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            id={`${inputId}-${file.id}`}
                            checked={selectedFileIds.includes(file.id)}
                            disabled={file.processingStatus !== "ready"}
                            onChange={(event) =>
                                onToggleFile(file.id, event.target.checked)
                            }
                            data-testid={`assistant-knowledge-${file.id}`}
                        />
                        <label htmlFor={`${inputId}-${file.id}`} className="flex-1">
                            {file.name}
                        </label>
                        {file.processingStatus !== "ready" && (
                            <span
                                className="text-xs text-zinc-500"
                                data-testid={`knowledge-status-${file.id}`}
                            >
                                {t(
                                    `assistantProfiles.fileStatus.${file.processingStatus}`
                                )}
                            </span>
                        )}
                        <button
                            type="button"
                            onClick={() => void removeFile(file.id)}
                            disabled={deletingId === file.id}
                            className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50 dark:hover:bg-zinc-800"
                            aria-label={t(
                                "assistantProfiles.knowledgeRemove"
                            ).replace("{name}", file.name)}
                            data-testid={`knowledge-remove-${file.id}`}
                        >
                            {deletingId === file.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Trash2 className="h-4 w-4" />
                            )}
                        </button>
                    </div>
                ))}

                {unavailable.map((entry) => (
                    <p
                        key={entry.fileId}
                        className="text-xs text-zinc-500"
                        data-testid={`knowledge-unavailable-${entry.fileId}`}
                    >
                        {t("assistantProfiles.knowledgeUnavailable").replace(
                            "{name}",
                            entry.name
                        )}
                    </p>
                ))}
            </div>

            <div className="flex items-center gap-2">
                <label
                    htmlFor={inputId}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-300 px-3 py-2 text-sm font-semibold transition hover:bg-zinc-50 focus-within:ring-2 focus-within:ring-zinc-500 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    data-testid="knowledge-add-label"
                >
                    {upload.kind === "working" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Upload className="h-4 w-4" />
                    )}
                    {t("assistantProfiles.knowledgeAdd")}
                </label>
                <input
                    ref={inputRef}
                    id={inputId}
                    type="file"
                    className="sr-only"
                    accept={capacity?.acceptedMediaTypes.join(",")}
                    disabled={upload.kind === "working"}
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void addFile(file);
                    }}
                    data-testid="knowledge-add-input"
                />
            </div>

            {upload.kind === "refused" && (
                <p
                    className="text-xs text-red-600 dark:text-red-400"
                    role="alert"
                    data-testid="knowledge-upload-error"
                >
                    {/* The shared table, not a chain of its own: this panel
                        sits behind the same guards as the editor above it, so
                        a profile that is gone or an account at its rate limit
                        reaches here too. The old fallback printed
                        `upload.detail` -- the server's English -- for every
                        code it did not name itself. */}
                    {t(
                        assistantProfileErrorCopyKey(upload.code) ??
                            "assistantProfiles.knowledgeUploadFailed"
                    )}
                </p>
            )}
            {upload.kind === "failed" && (
                <p
                    className="text-xs text-red-600 dark:text-red-400"
                    role="alert"
                    data-testid="knowledge-upload-error"
                >
                    {t("assistantProfiles.knowledgeUploadFailed")}
                </p>
            )}
        </fieldset>
    );
}
