import "server-only";

import { Worker } from "node:worker_threads";

import {
    CHAT_ARCHIVE_ERROR_CODES,
    CHAT_ARCHIVE_INFLATE_TIMEOUT_MS,
    CHAT_ARCHIVE_WORKER_MAX_OLD_SPACE_MB,
    chatArchiveLimits,
    type ChatArchiveErrorCode,
    type ChatArchiveScope,
} from "@/lib/chatArchiveLimits";
import {
    ChatArchivePlanError,
    planChatArchive,
    type ChatArchivePlan,
    type PlannedArchiveEntry,
} from "@/lib/chatArchivePlan";

/**
 * Opening an uploaded ZIP, safely, on the server.
 *
 * The refusal matrix lives in `lib/chatArchivePlan.ts` and runs first, on the
 * central directory alone. This module does the one thing that cannot be done
 * without spending CPU: inflating the entries the plan chose, in a worker
 * with a heap ceiling and a deadline, and then checking that what came out is
 * the size the directory said it would be.
 *
 * That last check is the point of the split. A ZIP entry may carry its sizes
 * in a trailing data descriptor rather than its local header, so a producer
 * -- or an attacker -- can describe an entry one way in the stream and
 * another way in the directory. Budgets were agreed against the directory, so
 * the stream is held to it: an entry that inflates to something else is a
 * refusal, not a resize.
 *
 * Nothing is written to disk. The archive is expanded in worker memory and
 * the selected entries come back as buffers, so there is no temporary
 * directory to clean up, no path to normalize into, and Zip Slip has nowhere
 * to land even before the path checks in the planner.
 */

export class ChatArchiveError extends Error {
    constructor(
        public readonly code: ChatArchiveErrorCode,
        public readonly status = 400
    ) {
        super(code);
        this.name = "ChatArchiveError";
    }
}

export type ExpandedArchiveFile = {
    readonly entry: PlannedArchiveEntry;
    readonly bytes: Buffer;
};

export type ExpandedArchive = {
    readonly plan: ChatArchivePlan;
    readonly files: readonly ExpandedArchiveFile[];
};

/**
 * Inflates only the named entries and stops the moment a budget is passed.
 *
 * `fflate`'s `Unzip` hands each entry to the callback before its data
 * arrives, and an entry whose `start()` is never called is skipped rather
 * than decompressed -- which is what keeps an archive full of media from
 * costing anything to walk past.
 */
const inflateWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { Unzip, UnzipInflate } = require("fflate");

const CODES = workerData.codes;

const fail = (code) => {
    parentPort.postMessage({ ok: false, code });
};

try {
    const wanted = new Map();
    for (const item of workerData.wanted) {
        for (const name of item.names) wanted.set(name, item);
    }

    const collected = new Map();
    let totalBytes = 0;
    let failure = null;

    const unzip = new Unzip((file) => {
        if (failure) return;
        const item = wanted.get(file.name);
        if (!item) return;
        if (collected.has(item.path)) {
            failure = CODES.corrupt;
            return;
        }
        const chunks = [];
        let size = 0;
        collected.set(item.path, null);
        file.ondata = (error, chunk, final) => {
            if (failure) return;
            if (error) {
                failure = CODES.corrupt;
                return;
            }
            if (chunk && chunk.length) {
                size += chunk.length;
                totalBytes += chunk.length;
                if (
                    size > item.uncompressedBytes ||
                    size > workerData.maxEntryBytes ||
                    totalBytes > workerData.maxTotalBytes
                ) {
                    failure = CODES.sizeMismatch;
                    try { file.terminate(); } catch {}
                    return;
                }
                chunks.push(Buffer.from(chunk));
            }
            if (final) {
                if (size !== item.uncompressedBytes) {
                    failure = CODES.sizeMismatch;
                    return;
                }
                collected.set(item.path, Buffer.concat(chunks, size));
            }
        };
        file.start();
    });
    unzip.register(UnzipInflate);
    unzip.push(new Uint8Array(workerData.buffer), true);

    if (failure) {
        fail(failure);
    } else {
        const files = [];
        for (const item of workerData.wanted) {
            const bytes = collected.get(item.path);
            if (!bytes) {
                failure = CODES.corrupt;
                break;
            }
            files.push({ path: item.path, bytes });
        }
        if (failure) fail(failure);
        else parentPort.postMessage({ ok: true, files });
    }
} catch {
    fail(CODES.corrupt);
}
`;

type InflateResult =
    | { ok: true; files: { path: string; bytes: Buffer }[] }
    | { ok: false; code: ChatArchiveErrorCode };

const runInflateWorker = (
    buffer: ArrayBuffer,
    wanted: {
        path: string;
        names: readonly string[];
        uncompressedBytes: number;
    }[],
    maxEntryBytes: number,
    maxTotalBytes: number
) =>
    new Promise<InflateResult>((resolve, reject) => {
        const worker = new Worker(inflateWorkerSource, {
            eval: true,
            workerData: {
                buffer,
                wanted,
                maxEntryBytes,
                maxTotalBytes,
                codes: CHAT_ARCHIVE_ERROR_CODES,
            },
            transferList: [buffer],
            resourceLimits: {
                maxOldGenerationSizeMb: CHAT_ARCHIVE_WORKER_MAX_OLD_SPACE_MB,
                maxYoungGenerationSizeMb: 32,
                stackSizeMb: 4,
            },
        });

        let settled = false;
        const finish = (error?: Error, result?: InflateResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            void worker.terminate();
            if (error) reject(error);
            else resolve(result as InflateResult);
        };
        const timeout = setTimeout(
            () => finish(new ChatArchiveError(CHAT_ARCHIVE_ERROR_CODES.timeout, 408)),
            CHAT_ARCHIVE_INFLATE_TIMEOUT_MS
        );

        worker.once("message", (message: InflateResult) => finish(undefined, message));
        // A worker that dies -- an out-of-memory kill included -- is the
        // archive's fault, not the caller's, and gets the same coded refusal
        // as a corrupt one rather than a 500.
        worker.once("error", () =>
            finish(new ChatArchiveError(CHAT_ARCHIVE_ERROR_CODES.corrupt))
        );
        worker.once("exit", (code) => {
            if (code !== 0) {
                finish(new ChatArchiveError(CHAT_ARCHIVE_ERROR_CODES.corrupt));
            }
        });
    });

/**
 * Plans and expands one archive.
 *
 * Throws `ChatArchiveError` with a code for every refusal -- the caller turns
 * it into an HTTP response, and the client turns the code into a sentence. No
 * entry path, parser message or byte ever travels with it.
 */
export async function expandChatArchive(
    buffer: Buffer,
    scope: ChatArchiveScope
): Promise<ExpandedArchive> {
    const limits = chatArchiveLimits(scope);

    let plan: ChatArchivePlan;
    try {
        plan = planChatArchive(
            new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
            limits
        );
    } catch (error) {
        if (error instanceof ChatArchivePlanError) {
            throw new ChatArchiveError(error.code);
        }
        throw new ChatArchiveError(CHAT_ARCHIVE_ERROR_CODES.corrupt);
    }

    // Copied rather than transferred from the caller's buffer: the caller
    // still needs its own bytes (to store, or to hash), and a transfer
    // detaches them.
    const transferable = Uint8Array.from(buffer).buffer;
    const result = await runInflateWorker(
        transferable,
        plan.entries.map((entry) => ({
            path: entry.path,
            names: entry.matchNames,
            uncompressedBytes: entry.uncompressedBytes,
        })),
        limits.maxEntryUncompressedBytes,
        limits.maxTotalUncompressedBytes
    );

    if (!result.ok) throw new ChatArchiveError(result.code);

    const byPath = new Map(result.files.map((file) => [file.path, file.bytes]));
    const files: ExpandedArchiveFile[] = [];
    for (const entry of plan.entries) {
        const bytes = byPath.get(entry.path);
        if (!bytes) throw new ChatArchiveError(CHAT_ARCHIVE_ERROR_CODES.corrupt);
        files.push({ entry, bytes: Buffer.from(bytes) });
    }

    return { plan, files };
}
