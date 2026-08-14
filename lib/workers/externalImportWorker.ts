/// <reference lib="webworker" />

import { Unzip, UnzipInflate } from "fflate";
import {
    detectExternalImportAdapter,
} from "@/lib/externalImportAdapters";
import type {
    ExternalAdapterProvider,
    ParsedExternalConversation,
} from "@/lib/externalImportAdapters/types";
import {
    ExternalImportArchiveError,
    classifyArchiveEntry,
    requiresStreamingParse,
    type ArchiveEntryInfo,
} from "@/lib/externalImportArchive";
import {
    JsonArrayStreamParser,
    ExternalImportJsonStreamError,
} from "@/lib/externalImportJsonStream";
import { EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS } from "@/lib/externalImportLimits";
import {
    buildImportPreview,
    mergeConversationSets,
    parseConversationItems,
    type ImportPreview,
} from "@/lib/externalImportPipeline";

/**
 * Web Worker that opens an external AI service export in the browser.
 *
 * docs/policy/external-conversation-import-and-memory.md §5.1.
 *
 * The archive never leaves the device: this worker inflates only the entries
 * that hold conversation data, hands them to the provider adapter, and posts
 * back a preview. The main thread sends normalized *text* to the server, and
 * only for the conversations the user then selects.
 *
 * Streaming throughout — fflate's Unzip pushes entry chunks as they arrive,
 * so media is skipped without ever being inflated and a 200MB conversations
 * file is decoded and parsed incrementally rather than materialized whole.
 */

export type WorkerRequest =
    | { type: "parse"; file: File }
    | { type: "cancel" };

export type WorkerResponse =
    | { type: "progress"; phase: "scanning" | "parsing"; bytesRead: number; conversationsFound: number }
    | { type: "preview"; preview: ImportPreview; conversations: ParsedExternalConversation[] }
    | { type: "cancelled" }
    | { type: "error"; reason: string; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

let cancelled = false;

const post = (message: WorkerResponse) => scope.postMessage(message);

const errorResponse = (error: unknown): WorkerResponse => {
    if (error instanceof ExternalImportArchiveError) {
        return { type: "error", reason: error.reason, message: error.message };
    }
    if (error instanceof ExternalImportJsonStreamError) {
        return { type: "error", reason: error.reason, message: error.message };
    }
    if (error instanceof RangeError) {
        // Allocation failures surface here on a device that cannot hold the
        // export; the UI turns this into the desktop recommendation rather
        // than a generic failure (§5.2).
        return {
            type: "error",
            reason: "out_of_memory",
            message: "The archive is too large for this device.",
        };
    }
    return {
        type: "error",
        reason: "unreadable_archive",
        message: "The archive could not be read.",
    };
};

/** Counts that belong to the export rather than to any one conversation. */
type ExportTotals = {
    nestedArchives: number;
    unassignedTurns: number;
    missingAttachments: number;
};

/**
 * Streams one archive, collecting parsed conversations. Entry decisions are
 * made from the entry header before any inflation begins.
 */
async function parseArchive(file: File): Promise<{
    conversations: ParsedExternalConversation[];
    provider: ExternalAdapterProvider;
    exportTotals: ExportTotals;
}> {
    if (
        file.size >
        EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxArchiveContainerBytes
    ) {
        throw new ExternalImportArchiveError(
            "The archive is larger than the supported limit.",
            "archive_too_large"
        );
    }

    // A bare .json export skips the archive path entirely.
    if (!file.name.toLowerCase().endsWith(".zip")) {
        const text = await file.text();
        const value = JSON.parse(text);
        const adapter = detectExternalImportAdapter(value);
        if (!adapter) {
            throw new ExternalImportArchiveError(
                "The file is not a supported export.",
                "no_conversation_data"
            );
        }
        const { conversations, extras } = parseConversationItems(
            adapter.provider,
            value as unknown[]
        );
        return {
            conversations,
            provider: adapter.provider,
            exportTotals: {
                nestedArchives: 0,
                unassignedTurns: extras.unassignedTurns,
                // A bare .json has no sibling files, so nothing can be found
                // missing here; the attachments were never in reach.
                missingAttachments: 0,
            },
        };
    }

    const collected: ParsedExternalConversation[][] = [];
    let provider: ExternalAdapterProvider | null = null;
    let entryCount = 0;
    let parsedBytes = 0;
    let bytesRead = 0;
    let conversationsFound = 0;
    let nestedArchivesSkipped = 0;
    let unassignedTurns = 0;
    /**
     * Every filename the archive holds, so an attachment a turn references can
     * be found absent (A2 §4.1). Basenames only: a reference names the file,
     * not its path. Names are all this keeps -- no entry is inflated for it.
     */
    const archivedNames = new Set<string>();
    const attachmentReferences: string[] = [];

    await new Promise<void>((resolve, reject) => {
        const decoder = new TextDecoder();
        const unzip = new Unzip((entry) => {
            if (cancelled) return;
            entryCount += 1;
            if (
                entryCount >
                EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxArchiveEntries
            ) {
                reject(
                    new ExternalImportArchiveError(
                        "The archive contains too many entries.",
                        "too_many_entries"
                    )
                );
                return;
            }

            const info: ArchiveEntryInfo = {
                name: entry.name,
                // originalSize is present when the entry header carries it;
                // fall back to the compressed size so an entry with an absent
                // header is still bounded rather than unbounded.
                uncompressedBytes: entry.originalSize ?? entry.size ?? 0,
                compressedBytes: entry.size,
            };
            const basename = entry.name.split("/").pop();
            if (basename) archivedNames.add(basename);

            const decision = classifyArchiveEntry(info);
            if (decision.kind === "reject") {
                reject(
                    new ExternalImportArchiveError(
                        `Refusing archive entry: ${decision.reason}.`,
                        decision.reason
                    )
                );
                return;
            }
            if (decision.kind === "skip") {
                // Never call entry.start(): the data is not inflated at all.
                // For a nested archive that is the whole guarantee -- depth
                // stays 0 because nothing here ever opens it.
                if (decision.reason === "nested_archive") {
                    nestedArchivesSkipped += 1;
                }
                return;
            }

            parsedBytes += info.uncompressedBytes;
            if (
                parsedBytes >
                EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxParsedTextTotalBytes
            ) {
                reject(
                    new ExternalImportArchiveError(
                        "The archive's parseable content exceeds the supported total.",
                        "parsed_budget_exceeded"
                    )
                );
                return;
            }

            const streaming = requiresStreamingParse(info);
            const streamParser = streaming ? new JsonArrayStreamParser() : null;
            let buffered = streaming ? "" : "";
            const items: unknown[] = [];

            entry.ondata = (error, chunk, final) => {
                if (cancelled) return;
                if (error) {
                    reject(error);
                    return;
                }
                try {
                    bytesRead += chunk.length;
                    const text = decoder.decode(chunk, { stream: !final });
                    if (streamParser) {
                        items.push(...streamParser.push(text));
                    } else {
                        buffered += text;
                    }
                    if (final) {
                        if (streamParser) streamParser.end();
                        else items.push(...(JSON.parse(buffered) as unknown[]));
                        buffered = "";

                        const detected =
                            provider ??
                            detectExternalImportAdapter(items)?.provider ??
                            null;
                        if (detected) {
                            provider = detected;
                            const parsed = parseConversationItems(
                                detected,
                                items
                            );
                            unassignedTurns += parsed.extras.unassignedTurns;
                            attachmentReferences.push(
                                ...parsed.extras.attachmentReferences
                            );
                            if (parsed.conversations.length > 0) {
                                collected.push(parsed.conversations);
                                conversationsFound +=
                                    parsed.conversations.length;
                            }
                        }
                        items.length = 0;
                        post({
                            type: "progress",
                            phase: "parsing",
                            bytesRead,
                            conversationsFound,
                        });
                    }
                } catch (parseError) {
                    reject(parseError);
                }
            };
            entry.start();
        });
        unzip.register(UnzipInflate);

        const reader = (file.stream() as ReadableStream<Uint8Array>).getReader();
        const pump = async () => {
            for (;;) {
                if (cancelled) {
                    await reader.cancel();
                    resolve();
                    return;
                }
                const { done, value } = await reader.read();
                if (done) {
                    unzip.push(new Uint8Array(0), true);
                    resolve();
                    return;
                }
                unzip.push(value, false);
                post({
                    type: "progress",
                    phase: "scanning",
                    bytesRead,
                    conversationsFound,
                });
            }
        };
        pump().catch(reject);
    });

    if (!provider) {
        throw new ExternalImportArchiveError(
            "The archive contains no conversation data.",
            "no_conversation_data"
        );
    }
    return {
        conversations: mergeConversationSets(collected),
        provider,
        exportTotals: {
            nestedArchives: nestedArchivesSkipped,
            unassignedTurns,
            missingAttachments: attachmentReferences.filter(
                (name) => !archivedNames.has(name)
            ).length,
        },
    };
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;
    if (request.type === "cancel") {
        cancelled = true;
        post({ type: "cancelled" });
        return;
    }
    if (request.type !== "parse") return;

    cancelled = false;
    try {
        const { conversations, provider, exportTotals } = await parseArchive(
            request.file
        );
        if (cancelled) {
            post({ type: "cancelled" });
            return;
        }
        post({
            type: "preview",
            preview: buildImportPreview(provider, conversations, exportTotals),
            conversations,
        });
    } catch (error) {
        post(errorResponse(error));
    }
};
