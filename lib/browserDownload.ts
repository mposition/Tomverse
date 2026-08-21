/**
 * Saving a server response as a file from inside the page, rather than by
 * navigating to it.
 *
 * Both conversation export and external-import export used to assign
 * `window.location.href` to a route that answers `Content-Disposition:
 * attachment` and let the browser decide what to do with it. That works, right
 * up until a browser decides to *render* the response instead: on 2026-08-19
 * the daily audit's mobile-safari project did exactly that, and the page the
 * export was started from went with it (run #39). The memory export, which
 * builds a blob in the page and clicks an `<a download>`, passed in the same
 * run.
 *
 * What real Safari does with that response could not be observed from CI, so
 * the harness alone was not treated as reason enough to move. The reason to
 * move is the other half: a navigation hands the whole outcome to the browser,
 * including the failures. A 402 or a 500 became a JSON error page the visitor
 * was navigated to, with the workspace gone. Fetching the response first means
 * a failure is still a failure *on the page that asked for it*, and can be said
 * in the product's own words.
 *
 * The trade this accepts is memory: `blob()` buffers a response these routes
 * stream. Exports are one conversation or one account's imported conversations,
 * which is the same order of size the memory export has always buffered.
 */

/**
 * The filename the server asked for.
 *
 * RFC 5987's `filename*` is preferred and is the only field that can carry a
 * non-ASCII name unambiguously; a quoted `filename` is taken literally, never
 * percent-decoded, because a quoted value is defined to be literal and guessing
 * would corrupt any name that legitimately contains a `%`.
 */
export function filenameFromContentDisposition(
    header: string | null,
    fallback: string
): string {
    if (!header) return fallback;

    const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
    if (encoded) {
        try {
            const decoded = decodeURIComponent(encoded.trim());
            if (decoded) return decoded;
        } catch {
            // A malformed `filename*` is not worth failing a download over.
        }
    }

    const quoted = /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1]?.trim();
    if (quoted) return quoted;

    const bare = /filename\s*=\s*([^;]+)/i.exec(header)?.[1]?.trim();
    return bare || fallback;
}

/** Hands a blob to the browser as a download named `filename`. */
export function saveBlobAsFile(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

/**
 * Saves an already-checked response as a file, using the name the server sent.
 *
 * The caller checks `response.ok` itself: what a failed export should say is
 * the caller's decision, and it differs per surface.
 */
export async function saveResponseAsFile(response: Response, fallbackName: string) {
    const filename = filenameFromContentDisposition(
        response.headers.get("content-disposition"),
        fallbackName
    );
    saveBlobAsFile(await response.blob(), filename);
}
