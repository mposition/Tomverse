/**
 * Reading a Compound File Binary Format container -- the thing a `.doc`,
 * `.xls` or `.ppt` actually is.
 *
 * Contract: docs/policy/chat-attachment-formats.md.
 *
 * A legacy Office file is a little filesystem: a header, a sector allocation
 * table, a directory tree, and streams stitched together from sectors that
 * may appear in any order. Nothing about it is text until three layers have
 * been walked, which is why "just add the extension" was never an option for
 * these formats.
 *
 * Everything here is bounded before it is read. A sector chain is a linked
 * list stored *in the file*, so a malformed or hostile container can point a
 * chain at itself, at a sector past the end, or at a chain long enough to
 * exhaust memory one 512-byte block at a time. Each of those is a refusal
 * with a code, and the budget that decides is passed in rather than assumed.
 *
 * Pure: bytes in, streams out. No worker, no I/O, no clock beyond the
 * deadline the caller supplies -- see `lib/legacyOfficeText.ts` for why these
 * parsers run in-process while `sharp`, `officeparser` and `pdfjs` get
 * workers.
 */

import {
    LegacyOfficeError,
    type LegacyParseBudget,
} from "@/lib/legacyOffice/budget";

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

/**
 * The largest value that is a real sector number. Everything above it is a
 * marker: 0xFFFFFFFC and 0xFFFFFFFD tag the allocation tables' own sectors,
 * which a chain never points at, and the two below are the ones a chain ends
 * with.
 */
const MAXREGSECT = 0xfffffffa;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

const HEADER_BYTES = 512;
const DIRECTORY_ENTRY_BYTES = 128;
const MINI_SECTOR_BYTES = 64;

/** Object types in a directory entry. */
const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;

export type CompoundFileEntry = {
    readonly name: string;
    readonly type: number;
    readonly startSector: number;
    readonly size: number;
};

export type CompoundFile = {
    /** Every stream in the container, keyed by lowercased name. */
    readonly streams: ReadonlyMap<string, CompoundFileEntry>;
    /** Reads one stream's bytes, against the budget. */
    readonly read: (entry: CompoundFileEntry) => Uint8Array;
};

export const hasCompoundFileSignature = (bytes: Uint8Array) =>
    bytes.length >= SIGNATURE.length &&
    SIGNATURE.every((byte, index) => bytes[index] === byte);

const viewOf = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * Follows one sector chain and returns the sector numbers in order.
 *
 * The three ways this goes wrong in a hostile file -- a sector past the end,
 * a chain that revisits a sector, and a chain longer than the container could
 * possibly justify -- are all refusals rather than best-effort reads. A
 * revisit check needs the set: a chain can loop back to any earlier link, not
 * only to itself.
 */
const followChain = (
    fat: Uint32Array,
    start: number,
    maxSectors: number,
    budget: LegacyParseBudget
): number[] => {
    const chain: number[] = [];
    const seen = new Set<number>();
    let sector = start;
    while (sector !== ENDOFCHAIN && sector !== FREESECT) {
        budget.tick();
        if (sector > MAXREGSECT || sector >= fat.length) {
            throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
        }
        if (seen.has(sector)) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
        seen.add(sector);
        chain.push(sector);
        if (chain.length > maxSectors) {
            throw new LegacyOfficeError("LEGACY_OFFICE_TOO_LARGE");
        }
        sector = fat[sector];
    }
    return chain;
};

/**
 * Opens the container.
 *
 * Returns the directory as a name -> entry map plus a reader, rather than
 * eagerly extracting every stream: a `.ppt` written by any real tool carries
 * a "Pictures" stream far larger than its text, and inflating it to find the
 * words would be paying for the part nobody asked for.
 */
export function openCompoundFile(
    bytes: Uint8Array,
    budget: LegacyParseBudget
): CompoundFile {
    if (!hasCompoundFileSignature(bytes) || bytes.length < HEADER_BYTES) {
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }

    const view = viewOf(bytes);
    const majorVersion = view.getUint16(26, true);
    const byteOrder = view.getUint16(28, true);
    const sectorShift = view.getUint16(30, true);
    const miniSectorShift = view.getUint16(32, true);
    const fatSectorCount = view.getUint32(44, true);
    const firstDirectorySector = view.getUint32(48, true);
    const miniStreamCutoff = view.getUint32(56, true);
    const firstMiniFatSector = view.getUint32(60, true);
    const miniFatSectorCount = view.getUint32(64, true);
    const firstDifatSector = view.getUint32(68, true);
    const difatSectorCount = view.getUint32(72, true);

    // Little-endian only, and only the two sector sizes the format defines.
    // A reader that guesses past this point is reading a different file.
    if (
        byteOrder !== 0xfffe ||
        miniSectorShift !== 6 ||
        (majorVersion === 3 && sectorShift !== 9) ||
        (majorVersion === 4 && sectorShift !== 12) ||
        (majorVersion !== 3 && majorVersion !== 4)
    ) {
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }

    const sectorSize = 1 << sectorShift;
    const sectorCount = Math.floor((bytes.length - HEADER_BYTES) / sectorSize);
    if (sectorCount <= 0) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");

    const sectorOffset = (sector: number) => HEADER_BYTES + sector * sectorSize;
    const readSector = (sector: number) => {
        if (sector < 0 || sector >= sectorCount) {
            throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
        }
        const start = sectorOffset(sector);
        return bytes.subarray(start, start + sectorSize);
    };

    // --- The FAT, via the DIFAT ---------------------------------------------
    //
    // The first 109 FAT sector numbers live in the header; the rest live in a
    // chain of DIFAT sectors, each of which ends with a pointer to the next.
    const fatSectors: number[] = [];
    for (let index = 0; index < 109 && fatSectors.length < fatSectorCount; index += 1) {
        const sector = view.getUint32(76 + index * 4, true);
        if (sector === FREESECT) break;
        fatSectors.push(sector);
    }

    let difatSector = firstDifatSector;
    const seenDifat = new Set<number>();
    const entriesPerDifat = sectorSize / 4 - 1;
    for (
        let index = 0;
        index < difatSectorCount && difatSector !== ENDOFCHAIN && difatSector !== FREESECT;
        index += 1
    ) {
        budget.tick();
        if (seenDifat.has(difatSector)) {
            throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
        }
        seenDifat.add(difatSector);
        const sector = readSector(difatSector);
        const sectorView = viewOf(sector);
        for (let slot = 0; slot < entriesPerDifat; slot += 1) {
            const value = sectorView.getUint32(slot * 4, true);
            if (value === FREESECT) continue;
            fatSectors.push(value);
        }
        difatSector = sectorView.getUint32(entriesPerDifat * 4, true);
    }

    if (fatSectors.length === 0) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    const fat = new Uint32Array(fatSectors.length * (sectorSize / 4));
    fatSectors.forEach((sector, index) => {
        budget.tick();
        const sectorView = viewOf(readSector(sector));
        for (let slot = 0; slot < sectorSize / 4; slot += 1) {
            fat[index * (sectorSize / 4) + slot] = sectorView.getUint32(slot * 4, true);
        }
    });

    // --- The directory ------------------------------------------------------
    const maxSectors = sectorCount + 1;
    const directorySectors = followChain(fat, firstDirectorySector, maxSectors, budget);
    const entries: CompoundFileEntry[] = [];
    const perSector = sectorSize / DIRECTORY_ENTRY_BYTES;
    for (const sector of directorySectors) {
        const data = readSector(sector);
        const dataView = viewOf(data);
        for (let slot = 0; slot < perSector; slot += 1) {
            budget.tick();
            const at = slot * DIRECTORY_ENTRY_BYTES;
            const type = data[at + 66];
            if (type !== TYPE_STORAGE && type !== TYPE_STREAM && type !== TYPE_ROOT) {
                continue;
            }
            const nameLength = dataView.getUint16(at + 64, true);
            if (nameLength < 2 || nameLength > 64) continue;
            // UTF-16LE including the terminator, which is not part of the name.
            const name = new TextDecoder("utf-16le").decode(
                data.subarray(at, at + nameLength - 2)
            );
            const startSector = dataView.getUint32(at + 116, true);
            const low = dataView.getUint32(at + 120, true);
            const high = dataView.getUint32(at + 124, true);
            // A v3 container leaves the high word unused, and a size past the
            // safe integer range is not a size this reader can hold to a
            // budget.
            const size = majorVersion === 3 ? low : high * 0x100000000 + low;
            if (!Number.isSafeInteger(size) || size < 0) {
                throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
            }
            entries.push({ name, type, startSector, size });
        }
    }

    const root = entries.find((entry) => entry.type === TYPE_ROOT);
    if (!root) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");

    // --- The mini stream ----------------------------------------------------
    //
    // Streams below the cutoff are packed into 64-byte mini sectors inside one
    // ordinary stream hanging off the root entry, with their own allocation
    // table. Built lazily: plenty of containers never use it.
    let miniFat: Uint32Array | null = null;
    let miniStream: Uint8Array | null = null;
    const ensureMiniStream = () => {
        if (miniStream) return;
        const miniFatSectors = followChain(fat, firstMiniFatSector, maxSectors, budget);
        if (miniFatSectors.length > miniFatSectorCount + 1) {
            throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
        }
        const table = new Uint32Array(miniFatSectors.length * (sectorSize / 4));
        miniFatSectors.forEach((sector, index) => {
            const sectorView = viewOf(readSector(sector));
            for (let slot = 0; slot < sectorSize / 4; slot += 1) {
                table[index * (sectorSize / 4) + slot] = sectorView.getUint32(
                    slot * 4,
                    true
                );
            }
        });
        miniFat = table;
        miniStream = readFromFat(root.startSector, root.size);
    };

    function readFromFat(startSector: number, size: number): Uint8Array {
        budget.claimBytes(size);
        const needed = Math.ceil(size / sectorSize);
        const chain = followChain(fat, startSector, maxSectors, budget);
        if (chain.length < needed) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
        const out = new Uint8Array(size);
        let written = 0;
        for (const sector of chain) {
            if (written >= size) break;
            const data = readSector(sector);
            const take = Math.min(sectorSize, size - written);
            out.set(data.subarray(0, take), written);
            written += take;
        }
        return out;
    }

    const readFromMiniFat = (startSector: number, size: number): Uint8Array => {
        budget.claimBytes(size);
        ensureMiniStream();
        const table = miniFat;
        const stream = miniStream;
        if (!table || !stream) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
        const chain = followChain(
            table,
            startSector,
            Math.ceil(stream.length / MINI_SECTOR_BYTES) + 1,
            budget
        );
        const out = new Uint8Array(size);
        let written = 0;
        for (const sector of chain) {
            if (written >= size) break;
            const at = sector * MINI_SECTOR_BYTES;
            if (at + MINI_SECTOR_BYTES > stream.length + MINI_SECTOR_BYTES) {
                throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
            }
            const take = Math.min(MINI_SECTOR_BYTES, size - written);
            out.set(stream.subarray(at, at + take), written);
            written += take;
        }
        return out;
    };

    const streams = new Map<string, CompoundFileEntry>();
    for (const entry of entries) {
        if (entry.type !== TYPE_STREAM) continue;
        // Lowercased because the names this reader looks for are fixed
        // ("WordDocument", "1Table") and their case has drifted between
        // producers; the original name is kept on the entry.
        const key = entry.name.toLowerCase();
        if (!streams.has(key)) streams.set(key, entry);
    }

    return {
        streams,
        read: (entry) => {
            if (entry.size === 0) return new Uint8Array(0);
            return entry.size < miniStreamCutoff
                ? readFromMiniFat(entry.startSector, entry.size)
                : readFromFat(entry.startSector, entry.size);
        },
    };
}

/** Reads a named stream, or `null` when the container does not have one. */
export const readCompoundStream = (
    file: CompoundFile,
    name: string
): Uint8Array | null => {
    const entry = file.streams.get(name.toLowerCase());
    return entry ? file.read(entry) : null;
};
