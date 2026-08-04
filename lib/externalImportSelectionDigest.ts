/**
 * Browser-side selection digest for external conversation import.
 *
 * docs/policy/external-conversation-import-and-memory.md §4.1.
 *
 * `lib/externalImportDigest.ts` is the server's definition and imports
 * `node:crypto`, so it cannot be bundled into the wizard. This module
 * reproduces exactly one of its functions — `externalImportDigest()`, the
 * sorted concatenation of conversation digests — on top of WebCrypto, so the
 * client can compute the `expectedImportDigest` it sends with a *subset*
 * finalize.
 *
 * Parity with the server is a test obligation, not a hope:
 * tests/externalImportSelectionDigest.test.mjs runs both implementations over
 * the same inputs. If the server ever changes the layout it must bump
 * `digestVersion`, and this file moves with it.
 *
 * The digest is a selection checksum, never an authorization token: the
 * server still re-derives every conversation digest from the rows it stored
 * and decides ownership from the session.
 */

const toHex = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return hex;
};

/**
 * SHA-256 over the lexicographically sorted, concatenated conversation
 * digests — byte-identical to the server's `externalImportDigest()`.
 *
 * Sorted rather than order-preserving: the same set of conversations is the
 * same import however the batches happened to arrive.
 */
export async function externalImportSelectionDigest(
    conversationDigests: readonly string[]
): Promise<string> {
    const input = [...conversationDigests].sort().join("");
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Error("WebCrypto is required to compute a selection digest.");
    }
    const encoded = new TextEncoder().encode(input);
    return toHex(await subtle.digest("SHA-256", encoded));
}
