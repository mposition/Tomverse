/**
 * The import's HTTP calls, as plain functions (Slice 5A).
 *
 * docs/policy/assistant-package-import.md §5.4, §5.6.
 *
 * Separated from the wizard component so that the order of the run -- create,
 * then one document at a time, then watch, then publish -- is readable in one
 * place without the rendering around it, and so each call's shape is stated
 * once rather than inline at the site that happens to make it.
 *
 * Every failure comes back as a thrown `ImportRequestError` carrying the
 * server's own code. The wizard renders a sentence per code; it never renders
 * the server's message, which is written for a developer and can name a path.
 */

export class ImportRequestError extends Error {
    constructor(
        readonly status: number,
        readonly code: string
    ) {
        super(`Import request failed: ${status} ${code}`);
        this.name = "ImportRequestError";
    }
}

/**
 * The server's error code, or a stand-in.
 *
 * A body that cannot be read is not an excuse to show nothing: the status is
 * still a fact, and a caller that got no code still has to say something.
 */
const codeFrom = async (response: Response): Promise<string> => {
    try {
        const body = (await response.json()) as { code?: unknown; error?: unknown };
        if (typeof body.code === "string" && body.code !== "") return body.code;
    } catch {
        // Fall through: an unreadable body is common on a 502 from in front
        // of the application, and it is not itself the interesting failure.
    }
    return `HTTP_${response.status}`;
};

const postJson = async <T,>(url: string, body: unknown): Promise<T> => {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new ImportRequestError(response.status, await codeFrom(response));
    }
    return (await response.json()) as T;
};

export type CreateImportBody = {
    mode: "create" | "merge";
    targetProfileId?: string;
    identity: { name: string; icon: string | null; description: string | null };
    stagingManifest: Record<string, unknown>;
    declared: {
        sourceKind: string | null;
        sourceName: string | null;
        sourceUrl: string | null;
        previousProvenance: Record<string, unknown> | null;
    };
};

export const createImport = (body: CreateImportBody) =>
    postJson<{ id: string; profileId: string; mode: string; status: string }>(
        "/api/assistant-profiles/imports",
        body
    );

export const prepareImportUpload = (
    importId: string,
    file: { filename: string; mime: string; bytes: number }
) =>
    postJson<{
        uploadKey: string;
        uploadUrl: string;
        uploadHeaders: Record<string, string>;
    }>(`/api/assistant-profiles/imports/${encodeURIComponent(importId)}/knowledge`, {
        action: "prepare",
        ...file,
    });

/**
 * The object itself, straight to storage.
 *
 * The bytes never pass through the application: `prepare` authorised exactly
 * this key, and `finalize` is what turns an object into a row. A failed PUT
 * therefore leaves nothing to clean up -- the reservation expires and the
 * abandoned-object sweep takes the key.
 */
export async function putImportObject(input: {
    uploadUrl: string;
    uploadHeaders: Record<string, string>;
    bytes: Uint8Array;
    mime: string;
}): Promise<void> {
    const response = await fetch(input.uploadUrl, {
        method: "PUT",
        headers: input.uploadHeaders,
        // A fresh ArrayBuffer rather than the view: a `Uint8Array` from the
        // worker may be a window onto a larger buffer, and sending the buffer
        // would upload the whole thing.
        body: input.bytes.slice().buffer as ArrayBuffer,
    });
    if (!response.ok) {
        throw new ImportRequestError(response.status, "ASSISTANT_PACKAGE_UPLOAD_FAILED");
    }
}

export const finalizeImportUpload = (
    importId: string,
    body: { uploadKey: string; filename: string; mime: string }
) =>
    postJson<{
        id: string;
        name: string;
        mime: string;
        bytes: number;
        processingStatus: string;
    }>(`/api/assistant-profiles/imports/${encodeURIComponent(importId)}/knowledge`, {
        action: "finalize",
        ...body,
    });

export type ImportSnapshot = {
    id: string;
    mode: string;
    status: string;
    profileId: string;
    ready: boolean;
    files: {
        id: string;
        name: string;
        processingStatus: string;
        failureCode: string | null;
    }[];
};

export async function readImport(importId: string): Promise<ImportSnapshot> {
    const response = await fetch(
        `/api/assistant-profiles/imports/${encodeURIComponent(importId)}`,
        { headers: { "Cache-Control": "no-store" } }
    );
    if (!response.ok) {
        throw new ImportRequestError(response.status, await codeFrom(response));
    }
    return (await response.json()) as ImportSnapshot;
}

export type PublishBody = {
    approvedDigest: string;
    digestVersion: number;
    keepFileIds: string[];
    identity: { name: string; icon: string | null; description: string | null };
    draft: {
        instructions: string;
        modelIds: string[];
        toolPolicy: { webSearch: boolean; deepResearch: boolean };
        memoryPolicy: { useAccountMemory: boolean };
        starters: string[];
    };
};

/**
 * What a publish can answer with.
 *
 * `stale` and `invalid` are not here: those come back as errors carrying their
 * own codes, which is right -- they are refusals, and the screen for them is
 * "reload and look again" rather than a variant of success.
 */
export type PublishResponse =
    | { outcome: "published"; version: { id: string; revision: number } }
    | { outcome: "unchanged"; revision: number }
    | { outcome: "not_ready"; pending: number; failed: number };

/**
 * `not_ready` arrives as a 409 and is still an answer.
 *
 * A document that is still being read is a state the owner waits out, so it
 * gets the counts rather than a generic failure. Every other non-2xx is a
 * refusal and throws.
 */
export async function publishImport(
    importId: string,
    body: PublishBody
): Promise<PublishResponse> {
    const response = await fetch(
        `/api/assistant-profiles/imports/${encodeURIComponent(importId)}/publish`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }
    );
    if (response.status === 409) {
        const parsed = (await response.json().catch(() => null)) as
            | { outcome?: string; pending?: number; failed?: number }
            | null;
        if (parsed?.outcome === "not_ready") {
            return {
                outcome: "not_ready",
                pending: parsed.pending ?? 0,
                failed: parsed.failed ?? 0,
            };
        }
        throw new ImportRequestError(409, (parsed as { code?: string })?.code ?? "HTTP_409");
    }
    if (!response.ok) {
        throw new ImportRequestError(response.status, await codeFrom(response));
    }
    return (await response.json()) as PublishResponse;
}

export async function cancelImport(importId: string): Promise<void> {
    const response = await fetch(
        `/api/assistant-profiles/imports/${encodeURIComponent(importId)}`,
        { method: "DELETE" }
    );
    if (!response.ok) {
        throw new ImportRequestError(response.status, await codeFrom(response));
    }
}

/** SHA-256 as lowercase hex, over the platform's own primitive. */
export async function sha256Hex(input: string): Promise<string> {
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}
