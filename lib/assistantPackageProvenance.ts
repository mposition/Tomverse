/**
 * What a package claimed about where it came from, prepared for display.
 *
 * Policy: docs/policy/assistant-package-import.md §6.5, §7.
 *
 * Pure, and separate from the profile service, because the rule it holds is
 * worth testing without a database: the server never saw the container, so
 * everything a package declared is a claim. The only processing done to a
 * claim before it reaches a screen is this -- reducing a stated URL to a host.
 */

/**
 * The host inside a declared source URL, or null.
 *
 * Null for anything unparseable, and for any scheme other than http(s). A
 * `javascript:` or `data:` string is not a place a package came from, and
 * putting one on screen under the heading "where this came from" would present
 * it as though it were.
 *
 * The host and nothing else, for the reason the wizard shows hosts for the
 * URLs it finds in instructions: a path or a query can carry a token. Nothing
 * fetches this either way -- §7 forbids re-reading a stored source URL at all
 * -- so the full URL has no display job left to do.
 */
export function declaredSourceHost(value: string | null): string | null {
    if (!value) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.host || null;
}
