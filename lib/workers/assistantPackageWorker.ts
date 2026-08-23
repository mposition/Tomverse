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

export type WorkerRequest = { type: "parse"; file: File } | { type: "cancel" };

export type WorkerResponse =
    | { type: "progress"; entriesRead: number; entriesPlanned: number }
    | { type: "review"; review: AssistantPackageReview }
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

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const message = event.data;
    if (message.type === "cancel") {
        cancelled = true;
        return;
    }
    cancelled = false;
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
