import { createProjectWorkspaceClient, type ProjectWorkspaceClient } from "@tomverse/api-client";

/**
 * The browser's transports for the shared Project workspace client: session
 * cookies via `fetch`, and a signed-URL PUT for file bytes (the same two-step
 * upload the Assistant knowledge panel uses).
 */
const putSignedUpload = async (url: string, headers: Record<string, string>, file: Blob) => {
    const response = await fetch(url, { method: "PUT", headers, body: file });
    if (!response.ok) {
        // The object never landed, so there is no row to clean up: the
        // abandoned-object sweep takes the key after its TTL.
        throw new Error("PROJECT_MATERIAL_UPLOAD_FAILED");
    }
};

let shared: ProjectWorkspaceClient | null = null;

/** One client for the page; it holds no state, so sharing it is only a saving of allocations. */
export function webProjectWorkspaceClient(): ProjectWorkspaceClient {
    shared ??= createProjectWorkspaceClient((path, init) => fetch(path, init), putSignedUpload);
    return shared;
}
