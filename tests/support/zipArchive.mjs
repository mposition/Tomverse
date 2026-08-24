// A ZIP writer for tests, built byte by byte.
//
// The package reader's job is mostly to refuse things, and a library that
// produces only well-formed archives cannot produce the archives it has to
// refuse: a symlink entry, an encrypted one, two entries with the same name, a
// declared size that does not match what the data inflates to. So the headers
// are written here directly, and every field a test needs to lie about is a
// parameter.
//
// Same reasoning as tests/support/compoundFile.mjs: the rejection paths are
// built from bytes, and the acceptance paths are checked against real files.

import { deflateSync } from "fflate";

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

export const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

const encoder = new TextEncoder();
const asBytes = (value) =>
    typeof value === "string" ? encoder.encode(value) : value;

/** Unix `lrwxrwxrwx` in the high half of the external attributes field. */
export const SYMLINK_EXTERNAL_ATTRIBUTES = (0xa1ff << 16) >>> 0;
/** The high byte of `versionMadeBy` that says the producer was a UNIX host. */
export const HOST_UNIX_VERSION_MADE_BY = (3 << 8) | 20;

/**
 * One entry.
 *
 * `name` and `data` are the only required fields. Everything else exists so a
 * test can produce an archive a well-behaved writer never would:
 *
 * - `method`: "store" or "deflate" (default), or a raw number for a method the
 *   reader must decline.
 * - `encrypted`: sets general-purpose bit 0 without actually encrypting, which
 *   is what the reader judges on.
 * - `symlink`: writes UNIX `versionMadeBy` and link-mode external attributes.
 * - `declaredUncompressedBytes` / `declaredCompressedBytes`: override the sizes
 *   in both headers, so the archive promises one thing and holds another.
 * - `externalAttributes`, `versionMadeBy`, `flags`: raw overrides.
 */
const buildEntry = (entry) => {
    const data = asBytes(entry.data ?? new Uint8Array(0));
    const methodName = entry.method ?? "deflate";
    const method =
        typeof methodName === "number"
            ? methodName
            : methodName === "store"
              ? 0
              : 8;
    const payload =
        method === 8 ? deflateSync(data, { level: entry.level ?? 6 }) : data;

    const uncompressedBytes = entry.declaredUncompressedBytes ?? data.length;
    const compressedBytes = entry.declaredCompressedBytes ?? payload.length;

    let flags = entry.flags ?? 0;
    if (entry.encrypted) flags |= 0x0001;

    const versionMadeBy =
        entry.versionMadeBy ?? (entry.symlink ? HOST_UNIX_VERSION_MADE_BY : 20);
    const externalAttributes =
        entry.externalAttributes ?? (entry.symlink ? SYMLINK_EXTERNAL_ATTRIBUTES : 0);

    return {
        name: encoder.encode(entry.name),
        payload,
        method,
        flags,
        crc: crc32(data),
        uncompressedBytes,
        compressedBytes,
        versionMadeBy,
        externalAttributes,
    };
};

/** A ZIP holding these entries, in this order. */
export function buildZip(entries) {
    const built = entries.map(buildEntry);
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const entry of built) {
        const local = new Uint8Array(30 + entry.name.length);
        const view = new DataView(local.buffer);
        view.setUint32(0, LOCAL_SIG, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, entry.flags, true);
        view.setUint16(8, entry.method, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, 0x21, true);
        view.setUint32(14, entry.crc, true);
        view.setUint32(18, entry.compressedBytes, true);
        view.setUint32(22, entry.uncompressedBytes, true);
        view.setUint16(26, entry.name.length, true);
        view.setUint16(28, 0, true);
        local.set(entry.name, 30);
        locals.push(local, entry.payload);

        const central = new Uint8Array(46 + entry.name.length);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, CENTRAL_SIG, true);
        centralView.setUint16(4, entry.versionMadeBy, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, entry.flags, true);
        centralView.setUint16(10, entry.method, true);
        centralView.setUint16(12, 0, true);
        centralView.setUint16(14, 0x21, true);
        centralView.setUint32(16, entry.crc, true);
        centralView.setUint32(20, entry.compressedBytes, true);
        centralView.setUint32(24, entry.uncompressedBytes, true);
        centralView.setUint16(28, entry.name.length, true);
        centralView.setUint16(30, 0, true);
        centralView.setUint16(32, 0, true);
        centralView.setUint16(34, 0, true);
        centralView.setUint16(36, 0, true);
        centralView.setUint32(38, entry.externalAttributes, true);
        centralView.setUint32(42, offset, true);
        central.set(entry.name, 46);
        centrals.push(central);

        offset += local.length + entry.payload.length;
    }

    const centralBytes = centrals.reduce((sum, part) => sum + part.length, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, EOCD_SIG, true);
    eocdView.setUint16(4, 0, true);
    eocdView.setUint16(6, 0, true);
    eocdView.setUint16(8, built.length, true);
    eocdView.setUint16(10, built.length, true);
    eocdView.setUint32(12, centralBytes, true);
    eocdView.setUint32(16, offset, true);
    eocdView.setUint16(20, 0, true);

    const parts = [...locals, ...centrals, eocd];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/** A byte-range reader over an in-memory archive, matching the module's port. */
export const readerFor = (bytes) => async (start, end) =>
    bytes.subarray(Math.max(0, start), Math.min(bytes.length, end));
