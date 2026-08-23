/// <reference lib="webworker" />

import {
    inflatePackageEntryFromBlob,
    planPackageRead,
    readPackageDirectoryFromBlob,
} from "@/lib/assistantPackageArchive";
import type { AssistantPackageRefusalCode } from "@/lib/assistantPackageLimits";
import {
    buildPackageReview,
    type AssistantPackageReview,
} from "@/lib/assistantPackageReview";

/**
 * Opens an assistant package in the browser, off the main thread (Slice 3).
 *
 * docs/policy/assistant-package-import.md §5, §8.
 *
 * The container never leaves the device: this worker reads the central
 * directory, decides the whole plan from it, inflates only the entries that
 * plan selected, and posts back a review. What the main thread later sends to
 * the server is the reviewed *content* the owner approved -- never the archive.
 *
 * Scripts are never inflated. Not "inflated and ignored": an entry the plan
 * did not select is an entry whose bytes are never decompressed and never
 * decoded, which is the only version of that promise that means anything.
 *
 * This file is deliberately thin. Everything it decides lives in
 * `lib/assistantPackageReview.ts`, so the decisions are tested without a
 * `Worker` and without a `File`.
 */

export type WorkerRequest =
    | { type: "parse"; file: File }
    /**
     * The bytes of entries the owner chose, read from the same container.
     *
     * The review deliberately carries no content -- it travels through
     * `postMessage`, is held in React state and is rendered, and a document's
     * text has no business in any of those. So when the upload step needs the
     * bytes it asks for exactly the paths it is about to send, and the
     * container is re-opened to get them. Re-inflating a handful of entries
     * costs less than keeping every document in memory through a review that
     * may be abandoned.
     */
    | { type: "extract"; file: File; paths: string[] }
    | { type: "cancel" };

export type WorkerResponse =
    | { type: "progress"; entriesRead: number; entriesPlanned: number }
    | { type: "review"; review: AssistantPackageReview }
    | { type: "extracted"; entries: { path: string; bytes: Uint8Array }[] }
    | { type: "refused"; code: AssistantPackageRefusalCode; cause: string }
    | { type: "cancelled" };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: WorkerResponse) => scope.postMessage(message);

let cancelled = false;

const encoder = new TextEncoder();

/** SHA-256 as lowercase hex, over the platform's own primitive. */
const sha256Hex = async (input: string | Uint8Array): Promise<string> => {
    const bytes = typeof input === "string" ? encoder.encode(input) : input;
    const digest = await crypto.subtle.digest(
        "SHA-256",
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    );
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
};

async function parse(file: File): Promise<void> {
    const directory = await readPackageDirectoryFromBlob(file);
    if (directory.outcome === "refused") {
        post({ type: "refused", code: directory.code, cause: directory.cause });
        return;
    }
    if (cancelled) return post({ type: "cancelled" });

    const plan = planPackageRead(directory.entries);
    if (plan.packageRefusal) {
        post({
            type: "refused",
            code: plan.packageRefusal.code,
            cause: plan.packageRefusal.cause,
        });
        return;
    }

    const entries = new Map<string, Uint8Array>();
    for (const [index, read] of plan.reads.entries()) {
        if (cancelled) return post({ type: "cancelled" });
        const bytes = await inflatePackageEntryFromBlob(read.entry, file);
        if (bytes.outcome === "refused") {
            post({
                type: "refused",
                code: "ASSISTANT_PACKAGE_UNSAFE_ENTRY",
                cause: bytes.reason,
            });
            return;
        }
        if (bytes.outcome === "unreadable") {
            post({
                type: "refused",
                code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
                cause: bytes.cause,
            });
            return;
        }
        entries.set(read.entry.path, bytes.bytes);
        post({
            type: "progress",
            entriesRead: index + 1,
            entriesPlanned: plan.reads.length,
        });
    }

    if (cancelled) return post({ type: "cancelled" });

    const result = await buildPackageReview({ plan, entries, sha256Hex });
    if (result.outcome === "refused") {
        post({ type: "refused", code: result.code, cause: result.cause });
        return;
    }
    post({ type: "review", review: result.review });
}

/**
 * Re-opens the container and returns only the entries named.
 *
 * The plan is rebuilt rather than remembered, so an entry that was refused or
 * skipped the first time is refused or skipped again: this path can never
 * inflate something the review path decided not to.
 */
async function extract(file: File, paths: readonly string[]): Promise<void> {
    const directory = await readPackageDirectoryFromBlob(file);
    if (directory.outcome === "refused") {
        post({ type: "refused", code: directory.code, cause: directory.cause });
        return;
    }
    const plan = planPackageRead(directory.entries);
    if (plan.packageRefusal) {
        post({
            type: "refused",
            code: plan.packageRefusal.code,
            cause: plan.packageRefusal.cause,
        });
        return;
    }

    const wanted = new Set(paths);
    const entries: { path: string; bytes: Uint8Array }[] = [];
    for (const read of plan.reads) {
        // The paths arrive from the main thread, so they are a request rather
        // than a decision. A script is not in `plan.reads` at all and could
        // never be named, but the manifest and the skill document are -- and
        // the upload step has no business with either. Narrowing to the role
        // keeps "what may be extracted" the same question the plan already
        // answered.
        if (read.role !== "knowledge" || !wanted.has(read.entry.path)) continue;
        const bytes = await inflatePackageEntryFromBlob(read.entry, file);
        if (bytes.outcome !== "read") {
            post({
                type: "refused",
                code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
                cause: bytes.outcome === "refused" ? bytes.reason : bytes.cause,
            });
            return;
        }
        entries.push({ path: read.entry.path, bytes: bytes.bytes });
    }
    post({ type: "extracted", entries });
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const message = event.data;
    if (message.type === "cancel") {
        cancelled = true;
        return;
    }
    cancelled = false;
    if (message.type === "extract") {
        void extract(message.file, message.paths).catch(() => {
            post({
                type: "refused",
                code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
                cause: "parser_error",
            });
        });
        return;
    }
    void parse(message.file).catch(() => {
        // A thrown error here is a parser fault, not a statement about the
        // package. It is reported as one, without the message: an exception
        // string can carry a path or a fragment of content, and §9 keeps both
        // out of anything that leaves this worker.
        post({
            type: "refused",
            code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
            cause: "parser_error",
        });
    });
};
