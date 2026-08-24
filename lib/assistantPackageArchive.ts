/**
 * Reading an assistant package's container, from its central directory (Slice 3).
 *
 * docs/policy/assistant-package-import.md §4, §5.2, §8.
 *
 * ## The order is the contract
 *
 * The directory is read first, the whole plan is decided from it, and only
 * then is anything inflated. That order is what makes the entry cap, the
 * per-entry ceiling and the total inflated budget mean something: a decision
 * made from a size that was reported before the bytes arrived is a decision
 * an archive bomb cannot walk past. It is also what keeps scripts from being
 * inflated at all -- not "inflated and then ignored", which is the same
 * memory and the same parser surface.
 *
 * ## Why this does not reuse `externalImportZipDirectory.ts`
 *
 * That reader answers a different question and is right to. It returns a map
 * keyed by entry name, so a duplicate name overwrites -- and duplicate and
 * case-colliding paths are two of the things this must refuse. It also fails
 * soft, returning `null` so its caller can fall back to local headers, which
 * is deliberate there: an export that used to import must keep importing. Here
 * a directory that cannot be read is a refusal, because a package we cannot
 * enumerate is a package we cannot report on. And it carries neither the
 * general-purpose flags nor the external attributes, which is where encryption
 * and symlinks are visible.
 *
 * ## What refusing a traversal path is actually for
 *
 * Nothing here writes to disk, so `../../etc/passwd` cannot escape anything --
 * there is nothing to escape. It is refused because it says what the producer
 * meant to do, and §8 puts the browser outside the security boundary: the
 * answer to a hostile producer is to stop, not to normalise the name and
 * carry on with the rest of its package.
 *
 * Isomorphic: byte ranges arrive through a reader function, so the tests run
 * the same code the worker does without constructing a `File`. No Prisma, no
 * R2, no clock, no network.
 */

import { inflateSync } from "fflate";

import {
    ASSISTANT_PACKAGE_ARCHIVE_EXTENSIONS,
    ASSISTANT_PACKAGE_KNOWLEDGE_EXTENSIONS,
    ASSISTANT_PACKAGE_LIMITS,
    ASSISTANT_PACKAGE_MEDIA_EXTENSIONS,
    ASSISTANT_PACKAGE_SCRIPT_EXTENSIONS,
    packageEntryExtension,
    type AssistantPackageRefusalCode,
    type AssistantPackageRefusedEntryReason,
    type AssistantPackageSkipReason,
} from "@/lib/assistantPackageLimits";
import { ASSISTANT_PACKAGE_MANIFEST_FILENAME } from "@/lib/assistantPackageManifest";

/* -------------------------------------------------------------- the reader */

/** Reads `[start, end)` of the container. End exclusive, `Blob.slice` style. */
export type PackageByteRangeReader = (
    start: number,
    end: number
) => Promise<Uint8Array>;

export type PackageZipEntry = {
    /** The name exactly as the directory stores it. Never becomes a path. */
    path: string;
    uncompressedBytes: number;
    compressedBytes: number;
    /** 0 stored, 8 deflate. Anything else this parser will not read. */
    compressionMethod: number;
    encrypted: boolean;
    symlink: boolean;
    directory: boolean;
    localHeaderOffset: number;
};

export type PackageDirectoryResult =
    | { outcome: "read"; entries: PackageZipEntry[] }
    | {
          outcome: "refused";
          code: AssistantPackageRefusalCode;
          /** A short machine-readable cause. Never an entry name (§9). */
          cause: string;
      };

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL_ENTRY = 0x02014b50;
const SIG_LOCAL_ENTRY = 0x04034b50;

const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const CENTRAL_ENTRY_MIN_BYTES = 46;
const LOCAL_ENTRY_MIN_BYTES = 30;
const ZIP64_EXTRA_HEADER_ID = 0x0001;
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

/** General-purpose bit 0. Set means the entry data is encrypted. */
const FLAG_ENCRYPTED = 0x0001;
/** The high byte of `versionMadeBy` when the producer was a UNIX host. */
const HOST_UNIX = 3;
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const viewOf = (bytes: Uint8Array): DataView =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * A ZIP64 field is a uint64 and every budget here is a JS number, so anything
 * past the safe range is refused rather than rounded: a rounded size is a size
 * that no longer represents what it will be compared against.
 */
const safeNumber = (value: bigint): number | null =>
    value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;

function findEocd(bytes: Uint8Array): number | null {
    if (bytes.length < EOCD_MIN_BYTES) return null;
    const view = viewOf(bytes);
    for (let at = bytes.length - EOCD_MIN_BYTES; at >= 0; at -= 1) {
        if (view.getUint32(at, true) === SIG_EOCD) return at;
    }
    return null;
}

type DirectoryLocation = { offset: number; size: number; entries: number };

async function locateDirectory(
    tail: Uint8Array,
    eocdAt: number,
    tailStart: number,
    read: PackageByteRangeReader
): Promise<DirectoryLocation | null> {
    const view = viewOf(tail);
    const entries = view.getUint16(eocdAt + 10, true);
    const size = view.getUint32(eocdAt + 12, true);
    const offset = view.getUint32(eocdAt + 16, true);

    const saturated =
        entries === ZIP64_SENTINEL_16 ||
        size === ZIP64_SENTINEL_32 ||
        offset === ZIP64_SENTINEL_32;
    if (!saturated) return { offset, size, entries };

    const locatorAt = eocdAt - 20;
    if (locatorAt < 0 || view.getUint32(locatorAt, true) !== SIG_ZIP64_LOCATOR) {
        return null;
    }
    const zip64At = safeNumber(view.getBigUint64(locatorAt + 8, true));
    if (zip64At === null) return null;

    const inTail = zip64At >= tailStart;
    const zip64 = inTail ? tail : await read(zip64At, zip64At + 56);
    const zip64At0 = inTail ? zip64At - tailStart : 0;
    if (zip64.length < zip64At0 + 56) return null;
    const zip64View = viewOf(zip64);
    if (zip64View.getUint32(zip64At0, true) !== SIG_ZIP64_EOCD) return null;

    const zEntries = safeNumber(zip64View.getBigUint64(zip64At0 + 32, true));
    const zSize = safeNumber(zip64View.getBigUint64(zip64At0 + 40, true));
    const zOffset = safeNumber(zip64View.getBigUint64(zip64At0 + 48, true));
    if (zEntries === null || zSize === null || zOffset === null) return null;
    return { offset: zOffset, size: zSize, entries: zEntries };
}

/**
 * The ZIP64 extra field carries only the values that were saturated, in a
 * fixed order, so which u64 to read depends on what came before it.
 */
function zip64Sizes(
    extra: Uint8Array,
    wantUncompressed: boolean,
    wantCompressed: boolean,
    wantOffset: boolean
): {
    uncompressedBytes?: number;
    compressedBytes?: number;
    localHeaderOffset?: number;
} | null {
    const view = viewOf(extra);
    let at = 0;
    while (at + 4 <= extra.length) {
        const id = view.getUint16(at, true);
        const size = view.getUint16(at + 2, true);
        const body = at + 4;
        if (body + size > extra.length) return null;
        if (id === ZIP64_EXTRA_HEADER_ID) {
            const out: {
                uncompressedBytes?: number;
                compressedBytes?: number;
                localHeaderOffset?: number;
            } = {};
            let cursor = body;
            const take = (): number | null => {
                if (cursor + 8 > body + size) return null;
                const value = safeNumber(view.getBigUint64(cursor, true));
                cursor += 8;
                return value;
            };
            if (wantUncompressed) {
                const value = take();
                if (value === null) return null;
                out.uncompressedBytes = value;
            }
            if (wantCompressed) {
                const value = take();
                if (value === null) return null;
                out.compressedBytes = value;
            }
            if (wantOffset) {
                const value = take();
                if (value === null) return null;
                out.localHeaderOffset = value;
            }
            return out;
        }
        at = body + size;
    }
    return null;
}

const utf8 = new TextDecoder("utf-8");

/**
 * Every entry the container declares, in directory order.
 *
 * Order is kept because duplicate and case-colliding paths are refusals, and a
 * map cannot express either. Refusing rather than returning `null` is the whole
 * difference from the conversation import's reader: see the header.
 */
export async function readPackageDirectory(
    totalBytes: number,
    read: PackageByteRangeReader
): Promise<PackageDirectoryResult> {
    const unreadable = (cause: string): PackageDirectoryResult => ({
        outcome: "refused",
        code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
        cause,
    });

    if (!Number.isFinite(totalBytes) || totalBytes < EOCD_MIN_BYTES) {
        return unreadable("too_short");
    }
    if (totalBytes > ASSISTANT_PACKAGE_LIMITS.maxContainerBytes) {
        return {
            outcome: "refused",
            code: "ASSISTANT_PACKAGE_TOO_LARGE",
            cause: "container_bytes",
        };
    }

    let tail: Uint8Array;
    let tailStart: number;
    try {
        const tailLength = Math.min(totalBytes, EOCD_MIN_BYTES + MAX_COMMENT_BYTES);
        tailStart = totalBytes - tailLength;
        tail = await read(tailStart, totalBytes);
    } catch {
        return unreadable("tail_unreadable");
    }

    const eocdAt = findEocd(tail);
    if (eocdAt === null) return unreadable("no_end_of_central_directory");

    let location: DirectoryLocation | null;
    try {
        location = await locateDirectory(tail, eocdAt, tailStart, read);
    } catch {
        return unreadable("zip64_unreadable");
    }
    if (!location) return unreadable("central_directory_not_located");

    const { offset, size, entries: declaredEntries } = location;
    if (offset < 0 || size < 0 || offset + size > totalBytes) {
        return unreadable("central_directory_out_of_range");
    }
    if (declaredEntries > ASSISTANT_PACKAGE_LIMITS.maxEntries) {
        return {
            outcome: "refused",
            code: "ASSISTANT_PACKAGE_TOO_MANY_ENTRIES",
            cause: "declared_entry_count",
        };
    }

    let directory: Uint8Array;
    try {
        directory =
            offset >= tailStart
                ? tail.subarray(offset - tailStart, offset - tailStart + size)
                : await read(offset, offset + size);
    } catch {
        return unreadable("central_directory_unreadable");
    }
    if (directory.length < size) return unreadable("central_directory_truncated");

    const view = viewOf(directory);
    const found: PackageZipEntry[] = [];
    let at = 0;
    while (at + CENTRAL_ENTRY_MIN_BYTES <= directory.length) {
        if (view.getUint32(at, true) !== SIG_CENTRAL_ENTRY) {
            return unreadable("central_entry_signature");
        }
        const versionMadeBy = view.getUint16(at + 4, true);
        const flags = view.getUint16(at + 8, true);
        const compressionMethod = view.getUint16(at + 10, true);
        const compressedRaw = view.getUint32(at + 20, true);
        const uncompressedRaw = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const externalAttributes = view.getUint32(at + 38, true);
        const offsetRaw = view.getUint32(at + 42, true);
        const nameAt = at + CENTRAL_ENTRY_MIN_BYTES;
        const extraAt = nameAt + nameLength;
        const next = extraAt + extraLength + commentLength;
        if (next > directory.length) return unreadable("central_entry_truncated");

        let uncompressedBytes = uncompressedRaw;
        let compressedBytes = compressedRaw;
        let localHeaderOffset = offsetRaw;
        const wantUncompressed = uncompressedRaw === ZIP64_SENTINEL_32;
        const wantCompressed = compressedRaw === ZIP64_SENTINEL_32;
        const wantOffset = offsetRaw === ZIP64_SENTINEL_32;
        if (wantUncompressed || wantCompressed || wantOffset) {
            const sizes = zip64Sizes(
                directory.subarray(extraAt, extraAt + extraLength),
                wantUncompressed,
                wantCompressed,
                wantOffset
            );
            if (!sizes) return unreadable("zip64_extra_field");
            if (sizes.uncompressedBytes !== undefined) {
                uncompressedBytes = sizes.uncompressedBytes;
            }
            if (sizes.compressedBytes !== undefined) {
                compressedBytes = sizes.compressedBytes;
            }
            if (sizes.localHeaderOffset !== undefined) {
                localHeaderOffset = sizes.localHeaderOffset;
            }
        }

        const path = utf8.decode(directory.subarray(nameAt, extraAt));
        const host = versionMadeBy >>> 8;
        const unixMode = (externalAttributes >>> 16) & 0xffff;
        found.push({
            path,
            uncompressedBytes,
            compressedBytes,
            compressionMethod,
            encrypted: (flags & FLAG_ENCRYPTED) !== 0,
            symlink: host === HOST_UNIX && (unixMode & S_IFMT) === S_IFLNK,
            directory: path.endsWith("/"),
            localHeaderOffset,
        });
        at = next;
    }

    if (found.length === 0) return unreadable("no_entries");
    if (found.length > ASSISTANT_PACKAGE_LIMITS.maxEntries) {
        return {
            outcome: "refused",
            code: "ASSISTANT_PACKAGE_TOO_MANY_ENTRIES",
            cause: "entry_count",
        };
    }
    return { outcome: "read", entries: found };
}

/* ---------------------------------------------------------------- the plan */

/** What an entry is to us, once we have decided to read it. */
export type PackageEntryRole =
    /** `assistant.json` at the root: this is a Tomverse native package. */
    | "manifest"
    /** `SKILL.md` at the root: this is an Agent Skill package. */
    | "skill_document"
    /** A document the owner may choose to bring across as knowledge. */
    | "knowledge";

export type PackageEntryVerdict =
    | { disposition: "refuse"; reason: AssistantPackageRefusedEntryReason }
    | { disposition: "skip"; reason: AssistantPackageSkipReason }
    | { disposition: "read"; role: PackageEntryRole };

export type PackagePlan = {
    /** Entries to inflate, in directory order. */
    reads: { entry: PackageZipEntry; role: PackageEntryRole }[];
    /** Entries deliberately not read, each under its own reason. */
    skips: { path: string; reason: AssistantPackageSkipReason }[];
    /**
     * Any entry here refuses the whole package. It is a list rather than the
     * first one found so the wizard can say what is wrong with the package
     * instead of what is wrong with its first bad entry.
     */
    refusals: { path: string; reason: AssistantPackageRefusedEntryReason }[];
    /** Sum of the declared sizes of `reads`. */
    plannedInflatedBytes: number;
    /** Set when the plan itself is over a package-level budget. */
    packageRefusal: { code: AssistantPackageRefusalCode; cause: string } | null;
};

const isTraversal = (path: string): boolean =>
    // A backslash is a legal character in a POSIX filename and a separator on
    // Windows, so a name carrying one denotes two different paths depending on
    // who opens it. That ambiguity is the attack, whatever the segments say.
    path.includes("\\") || path.split("/").some((segment) => segment === "..");

// A leading slash, or a Windows drive letter. The drive test is deliberately
// loose: it also catches a name like `a:notes.md`, which is legal on POSIX and
// which no package this feature accepts has a reason to contain.
const isAbsolute = (path: string): boolean =>
    path.startsWith("/") || /^[A-Za-z]:/.test(path);

/**
 * What one entry is, decided from its directory record alone.
 *
 * `seen` carries the paths judged so far, which is how duplicate and
 * case-colliding names are caught -- both are refusals because a package that
 * names one path twice has no single answer to "what is in this file", and on
 * a case-insensitive filesystem `README.md` and `readme.md` are that same
 * question asked in a way that looks fine until it is unpacked somewhere else.
 */
export function classifyPackageEntry(
    entry: PackageZipEntry,
    seen: { paths: Set<string>; lowered: Set<string> }
): PackageEntryVerdict {
    // Name-shaped refusals come first and apply to every entry, read or not:
    // they describe the producer rather than the file, and §8 says the answer
    // to a hostile producer is to stop.
    if (isTraversal(entry.path)) return { disposition: "refuse", reason: "path_traversal" };
    if (isAbsolute(entry.path)) return { disposition: "refuse", reason: "absolute_path" };
    if (entry.symlink) return { disposition: "refuse", reason: "symlink" };
    if (entry.encrypted) return { disposition: "refuse", reason: "encrypted" };
    if (seen.paths.has(entry.path)) {
        return { disposition: "refuse", reason: "duplicate_path" };
    }
    if (seen.lowered.has(entry.path.toLowerCase())) {
        return { disposition: "refuse", reason: "case_collision" };
    }

    if (entry.directory) return { disposition: "skip", reason: "directory" };

    const extension = packageEntryExtension(entry.path);
    if (ASSISTANT_PACKAGE_ARCHIVE_EXTENSIONS.has(extension)) {
        // Depth stays 0. Reported under its own reason rather than as an
        // unsupported extension, because "we do not open archives" is a
        // decision the owner should see stated.
        return { disposition: "skip", reason: "nested_archive" };
    }
    if (ASSISTANT_PACKAGE_SCRIPT_EXTENSIONS.has(extension)) {
        return { disposition: "skip", reason: "executable_script" };
    }
    if (ASSISTANT_PACKAGE_MEDIA_EXTENSIONS.has(extension)) {
        return { disposition: "skip", reason: "media" };
    }

    if (entry.path === ASSISTANT_PACKAGE_MANIFEST_FILENAME) {
        return { disposition: "read", role: "manifest" };
    }
    if (entry.path === "SKILL.md") {
        return { disposition: "read", role: "skill_document" };
    }

    if (entry.uncompressedBytes === 0) return { disposition: "skip", reason: "empty" };
    if (ASSISTANT_PACKAGE_KNOWLEDGE_EXTENSIONS.has(extension)) {
        return { disposition: "read", role: "knowledge" };
    }
    return { disposition: "skip", reason: "unsupported_extension" };
}

/**
 * The whole read, decided before a byte is inflated.
 *
 * Size and ratio refusals are applied only to entries that would be read. An
 * entry nothing inflates cannot exhaust anything, and refusing a package
 * because of a 40MB video it merely contains would be a refusal the owner has
 * no way to act on -- the file was never going to be used.
 */
export function planPackageRead(entries: readonly PackageZipEntry[]): PackagePlan {
    const seen = { paths: new Set<string>(), lowered: new Set<string>() };
    const plan: PackagePlan = {
        reads: [],
        skips: [],
        refusals: [],
        plannedInflatedBytes: 0,
        packageRefusal: null,
    };

    for (const entry of entries) {
        const verdict = classifyPackageEntry(entry, seen);
        seen.paths.add(entry.path);
        seen.lowered.add(entry.path.toLowerCase());

        if (verdict.disposition === "refuse") {
            plan.refusals.push({ path: entry.path, reason: verdict.reason });
            continue;
        }
        if (verdict.disposition === "skip") {
            plan.skips.push({ path: entry.path, reason: verdict.reason });
            continue;
        }

        if (entry.uncompressedBytes > ASSISTANT_PACKAGE_LIMITS.maxEntryBytes) {
            plan.refusals.push({ path: entry.path, reason: "entry_too_large" });
            continue;
        }
        if (
            entry.compressedBytes > 0 &&
            entry.uncompressedBytes / entry.compressedBytes >
                ASSISTANT_PACKAGE_LIMITS.maxEntryCompressionRatio
        ) {
            plan.refusals.push({
                path: entry.path,
                reason: "suspicious_compression_ratio",
            });
            continue;
        }

        plan.reads.push({ entry, role: verdict.role });
        plan.plannedInflatedBytes += entry.uncompressedBytes;
    }

    if (plan.refusals.length > 0) {
        plan.packageRefusal = {
            code: "ASSISTANT_PACKAGE_UNSAFE_ENTRY",
            cause: plan.refusals[0].reason,
        };
    } else if (
        plan.plannedInflatedBytes > ASSISTANT_PACKAGE_LIMITS.maxTotalInflatedBytes
    ) {
        plan.packageRefusal = {
            code: "ASSISTANT_PACKAGE_TOO_LARGE",
            cause: "total_inflated_bytes",
        };
    }
    return plan;
}

/* ------------------------------------------------------------ the inflation */

export type PackageEntryBytes =
    | { outcome: "read"; bytes: Uint8Array }
    | { outcome: "refused"; reason: AssistantPackageRefusedEntryReason }
    | { outcome: "unreadable"; cause: string };

/**
 * One entry's bytes, checked against what the directory promised.
 *
 * The size comparison is the point rather than a sanity check. Every budget in
 * the plan above was computed from the directory's numbers, so an entry that
 * inflates to something else has walked past all of them; the only safe
 * reading of that is that the container is lying, and the entry is refused.
 *
 * The CRC is deliberately not verified. It would catch corruption, which is
 * not what this is defending against, and it cannot catch a hostile producer
 * -- who can compute a correct CRC for whatever they wrote. The size is the
 * value the budgets actually rest on.
 */
export async function inflatePackageEntry(
    entry: PackageZipEntry,
    read: PackageByteRangeReader
): Promise<PackageEntryBytes> {
    if (
        entry.compressionMethod !== METHOD_STORE &&
        entry.compressionMethod !== METHOD_DEFLATE
    ) {
        return { outcome: "unreadable", cause: "compression_method" };
    }
    if (entry.uncompressedBytes > ASSISTANT_PACKAGE_LIMITS.maxEntryBytes) {
        return { outcome: "refused", reason: "entry_too_large" };
    }

    let header: Uint8Array;
    try {
        header = await read(
            entry.localHeaderOffset,
            entry.localHeaderOffset + LOCAL_ENTRY_MIN_BYTES
        );
    } catch {
        return { outcome: "unreadable", cause: "local_header_unreadable" };
    }
    if (header.length < LOCAL_ENTRY_MIN_BYTES) {
        return { outcome: "unreadable", cause: "local_header_truncated" };
    }
    const headerView = viewOf(header);
    if (headerView.getUint32(0, true) !== SIG_LOCAL_ENTRY) {
        return { outcome: "unreadable", cause: "local_header_signature" };
    }
    // The local header's own name and extra lengths are read rather than the
    // directory's: a producer is free to write a different extra field here,
    // and using the wrong one starts the data at the wrong offset.
    const nameLength = headerView.getUint16(26, true);
    const extraLength = headerView.getUint16(28, true);
    const dataAt =
        entry.localHeaderOffset + LOCAL_ENTRY_MIN_BYTES + nameLength + extraLength;

    let compressed: Uint8Array;
    try {
        compressed = await read(dataAt, dataAt + entry.compressedBytes);
    } catch {
        return { outcome: "unreadable", cause: "entry_unreadable" };
    }
    if (compressed.length < entry.compressedBytes) {
        return { outcome: "unreadable", cause: "entry_truncated" };
    }

    let bytes: Uint8Array;
    if (entry.uncompressedBytes === 0) {
        // fflate is given an output buffer to bound it, and a zero-length one
        // is not a bound it can work with. An entry that promises nothing is
        // answered directly.
        bytes = new Uint8Array(0);
    } else if (entry.compressionMethod === METHOD_STORE) {
        bytes = compressed;
    } else {
        try {
            // One byte more than promised, deliberately.
            //
            // fflate fills the buffer it is given and stops -- it does not
            // throw when there is more to write. Sized at exactly the promised
            // length, an entry that inflates to more would come back at
            // exactly the promised length, pass the check below, and be
            // accepted silently truncated. The extra byte is what turns "more
            // than promised" into a length that cannot match.
            bytes = inflateSync(compressed, {
                out: new Uint8Array(entry.uncompressedBytes + 1),
            });
        } catch {
            return { outcome: "unreadable", cause: "inflate_failed" };
        }
    }

    if (bytes.length !== entry.uncompressedBytes) {
        return { outcome: "refused", reason: "suspicious_compression_ratio" };
    }
    return { outcome: "read", bytes };
}

/** `readPackageDirectory` over an uploaded file. */
export async function readPackageDirectoryFromBlob(
    file: Blob
): Promise<PackageDirectoryResult> {
    return readPackageDirectory(file.size, async (start, end) => {
        const slice = await file.slice(start, end).arrayBuffer();
        return new Uint8Array(slice);
    });
}

/** `inflatePackageEntry` over an uploaded file. */
export async function inflatePackageEntryFromBlob(
    entry: PackageZipEntry,
    file: Blob
): Promise<PackageEntryBytes> {
    return inflatePackageEntry(entry, async (start, end) => {
        const slice = await file.slice(start, end).arrayBuffer();
        return new Uint8Array(slice);
    });
}
