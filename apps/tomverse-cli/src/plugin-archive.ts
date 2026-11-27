import { mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { insideFolder, PLUGIN_LIMITS, PluginError } from "./plugin-fs.js";

/**
 * Unpacking a zip file or an npm tarball into an empty staging folder. The archive is third-party data, so nothing in it decides where a
 * file goes or what it is: a name that is absolute, climbs out with `..`, uses a backslash, a drive letter or a stream suffix is refused;
 * a link or any entry that is not a plain file or folder is refused (nothing here ever creates a link); the entry count, every size
 * (declared, then actually unpacked) and the nesting are bounded before anything is written. Nothing is run, and no install script of an
 * npm package is read as anything but a file.
 */

export const ARCHIVE_LIMITS = {
    /** The archive file as downloaded or picked. */
    archiveBytes: 60 * 1024 * 1024,
    entries: 10_000,
    nameLength: 400,
    segmentLength: 255,
    /** A tarball is a stream of 512-byte blocks: the unpacked stream may exceed the files' bytes by this much. */
    tarOverhead: 8 * 1024 * 1024,
} as const;

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** One entry name as a clean relative path, or null for an entry to skip (`.git`). Throws PluginError for a name that is not safe. */
export const safeEntryName = (raw: string): { path: string; directory: boolean } | null => {
    if (!raw || raw.length > ARCHIVE_LIMITS.nameLength) throw new PluginError("The archive has an entry with an empty or very long name.");
    if (/[\u0000-\u001f\u007f\\]/.test(raw)) throw new PluginError("The archive has an entry name with a backslash or a control character, which is not accepted.");
    if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new PluginError("The archive has an entry with an absolute path.");
    const directory = raw.endsWith("/");
    const parts = (directory ? raw.slice(0, -1) : raw).split("/").filter((part) => part !== ".");
    if (parts.some((part) => part === "")) throw new PluginError("The archive has an entry with an empty path part.");
    // The archive's own top folder (`./`) names nothing to write.
    if (!parts.length && directory) return null;
    for (const part of parts) {
        if (part === "..") throw new PluginError("The archive has an entry that climbs out of its folder.");
        if (part.length > ARCHIVE_LIMITS.segmentLength || part.includes(":") || /[. ]$/.test(part) || RESERVED.test(part)) {
            throw new PluginError("The archive has an entry name this computer cannot hold safely.");
        }
    }
    if (!parts.length) throw new PluginError("The archive has an entry without a name.");
    // One level of wrapper folder (`repo-main/`, `package/`) is allowed on top of the plugin's own depth.
    if (parts.length > PLUGIN_LIMITS.depth + 2) throw new PluginError("The archive is nested too deeply.");
    if (parts.includes(".git")) return null;
    return { path: parts.join("/"), directory };
};

/** Where an archive's entries are written, with the counts the limits are checked against. */
export class ArchiveSink {
    files = 0;
    bytes = 0;
    entries = 0;
    private readonly realDestination: string;
    private readonly seen = new Set<string>();

    constructor(readonly destination: string) {
        mkdirSync(destination, { recursive: true });
        this.realDestination = realpathSync.native(destination);
    }

    private place(path: string) {
        const target = resolve(this.realDestination, ...path.split("/"));
        if (!insideFolder(this.realDestination, target) || target === this.realDestination) throw new PluginError("An archive entry would leave the plugin folder.");
        return target;
    }

    count() {
        this.entries += 1;
        if (this.entries > ARCHIVE_LIMITS.entries) throw new PluginError("The archive has too many entries.");
    }

    /** Checked against the declared size before anything is unpacked. */
    declare(size: number, shown: string) {
        if (size > PLUGIN_LIMITS.fileBytes) throw new PluginError(`${shown} is larger than ${PLUGIN_LIMITS.fileBytes / 1024 / 1024} MB.`);
        if (this.files + 1 > PLUGIN_LIMITS.files) throw new PluginError(`The plugin has more than ${PLUGIN_LIMITS.files} files.`);
        if (this.bytes + size > PLUGIN_LIMITS.bytes) throw new PluginError(`The plugin is larger than ${PLUGIN_LIMITS.bytes / 1024 / 1024} MB.`);
    }

    directory(path: string) {
        try {
            mkdirSync(this.place(path), { recursive: true });
        } catch (error) {
            if (error instanceof PluginError) throw error;
            throw new PluginError("The archive has a folder that clashes with a file.");
        }
    }

    file(path: string, data: Buffer, executable: boolean) {
        this.declare(data.length, path);
        const key = path.toLowerCase();
        if (this.seen.has(key)) throw new PluginError(`The archive has the file ${path} twice.`);
        this.seen.add(key);
        const target = this.place(path);
        try {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, data, { flag: "wx", mode: executable ? 0o755 : 0o644 });
        } catch (error) {
            if (error instanceof PluginError) throw error;
            throw new PluginError(`The archive file ${path} clashes with another entry.`);
        }
        this.files += 1;
        this.bytes += data.length;
    }
}

/* ------------------------------------------------------------------------------------------------ zip */

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

const crc32 = (data: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
};

/** Unpacks a zip file (stored or deflated entries; no encryption, no ZIP64, no links) into the sink. */
export const extractZip = (archive: Buffer, sink: ArchiveSink): void => {
    if (archive.length > ARCHIVE_LIMITS.archiveBytes) throw new PluginError("The zip file is too large.");
    if (archive.length < 22) throw new PluginError("That is not a zip file.");
    let end = -1;
    for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at -= 1) {
        if (archive.readUInt32LE(at) === 0x06054b50) { end = at; break; }
    }
    if (end < 0) throw new PluginError("That is not a zip file.");
    const disk = archive.readUInt16LE(end + 4);
    const directoryDisk = archive.readUInt16LE(end + 6);
    const count = archive.readUInt16LE(end + 10);
    const directorySize = archive.readUInt32LE(end + 12);
    const directoryOffset = archive.readUInt32LE(end + 16);
    if (disk !== 0 || directoryDisk !== 0) throw new PluginError("A zip file in several parts is not supported.");
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new PluginError("A ZIP64 file is not supported.");
    if (count > ARCHIVE_LIMITS.entries) throw new PluginError("The archive has too many entries.");
    if (directoryOffset + directorySize > end) throw new PluginError("The zip file's table of contents is damaged.");

    let at = directoryOffset;
    for (let index = 0; index < count; index += 1) {
        if (at + 46 > end || archive.readUInt32LE(at) !== 0x02014b50) throw new PluginError("The zip file's table of contents is damaged.");
        const made = archive.readUInt16LE(at + 4);
        const flags = archive.readUInt16LE(at + 8);
        const method = archive.readUInt16LE(at + 10);
        const crc = archive.readUInt32LE(at + 16);
        const compressed = archive.readUInt32LE(at + 20);
        const size = archive.readUInt32LE(at + 24);
        const nameLength = archive.readUInt16LE(at + 28);
        const extraLength = archive.readUInt16LE(at + 30);
        const commentLength = archive.readUInt16LE(at + 32);
        const attributes = archive.readUInt32LE(at + 38);
        const localOffset = archive.readUInt32LE(at + 42);
        if (at + 46 + nameLength + extraLength + commentLength > end) throw new PluginError("The zip file's table of contents is damaged.");
        const rawName = archive.toString("utf8", at + 46, at + 46 + nameLength);
        at += 46 + nameLength + extraLength + commentLength;
        sink.count();

        const entry = safeEntryName(rawName);
        // The type of an entry comes from the Unix mode the archive records (host system 3); a link or a device is refused, not unpacked as a file.
        const mode = made >> 8 === 3 ? attributes >>> 16 : 0;
        const type = mode & 0o170000;
        if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw new PluginError(`The archive entry ${entry?.path ?? "(skipped)"} is a link or a special file, which is not accepted.`);
        if (!entry) continue;
        if (entry.directory || type === 0o040000) {
            sink.directory(entry.path);
            continue;
        }
        if (flags & 0x1 || flags & 0x40) throw new PluginError("An encrypted zip file is not supported.");
        if (method !== 0 && method !== 8) throw new PluginError(`The archive entry ${entry.path} uses a compression this app does not read.`);
        if (compressed === 0xffffffff || size === 0xffffffff) throw new PluginError("A ZIP64 file is not supported.");
        sink.declare(size, entry.path);

        if (localOffset + 30 > directoryOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new PluginError("The zip file is damaged.");
        const localName = localOffset + 30;
        const localNameLength = archive.readUInt16LE(localOffset + 26);
        const localExtraLength = archive.readUInt16LE(localOffset + 28);
        if (archive.toString("utf8", localName, localName + localNameLength) !== rawName) throw new PluginError("The zip file is damaged: an entry's two names differ.");
        const start = localName + localNameLength + localExtraLength;
        if (start + compressed > directoryOffset) throw new PluginError("The zip file is damaged.");
        const stored = archive.subarray(start, start + compressed);
        let data: Buffer;
        if (method === 0) {
            if (compressed !== size) throw new PluginError(`The archive entry ${entry.path} is damaged.`);
            data = Buffer.from(stored);
        } else {
            try {
                data = inflateRawSync(stored, { maxOutputLength: size });
            } catch {
                throw new PluginError(`The archive entry ${entry.path} is damaged or unpacks to more than it says.`);
            }
        }
        if (data.length !== size || crc32(data) !== crc) throw new PluginError(`The archive entry ${entry.path} is damaged.`);
        sink.file(entry.path, data, (mode & 0o111) !== 0);
    }
};

/* ------------------------------------------------------------------------------------------------ tar.gz */

const tarText = (block: Buffer, from: number, length: number) => {
    const slice = block.subarray(from, from + length);
    const stop = slice.indexOf(0);
    return slice.toString("utf8", 0, stop < 0 ? slice.length : stop);
};

const tarNumber = (block: Buffer, from: number, length: number, what: string) => {
    if (block[from]! & 0x80) throw new PluginError(`The tarball has a ${what} this app does not read.`);
    const text = tarText(block, from, length).trim();
    if (!text) return 0;
    if (!/^[0-7]+$/.test(text)) throw new PluginError("The tarball is damaged.");
    return parseInt(text, 8);
};

const paxRecords = (data: Buffer) => {
    const out: Record<string, string> = {};
    let at = 0;
    while (at < data.length) {
        const space = data.indexOf(0x20, at);
        const length = Number(data.toString("utf8", at, space));
        if (space < 0 || !Number.isInteger(length) || length <= space - at + 1 || at + length > data.length) throw new PluginError("The tarball is damaged.");
        const record = data.toString("utf8", space + 1, at + length - 1);
        const equals = record.indexOf("=");
        if (equals > 0) out[record.slice(0, equals)] = record.slice(equals + 1);
        at += length;
    }
    return out;
};

/** Unpacks a gzip-compressed tarball (an `npm pack` file) into the sink. A link, a device or a pax size over the limit is refused. */
export const extractTarGz = (archive: Buffer, sink: ArchiveSink): void => {
    if (archive.length > ARCHIVE_LIMITS.archiveBytes) throw new PluginError("The tarball is too large.");
    let tar: Buffer;
    try {
        tar = gunzipSync(archive, { maxOutputLength: PLUGIN_LIMITS.bytes + ARCHIVE_LIMITS.tarOverhead });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new PluginError("The tarball unpacks to more than the plugin size limit.");
        throw new PluginError("That is not a gzip-compressed tarball.");
    }
    let at = 0;
    let longName: string | undefined;
    let pax: Record<string, string> = {};
    while (at + 512 <= tar.length) {
        const header = tar.subarray(at, at + 512);
        if (header.every((byte) => byte === 0)) break;
        let sum = 0;
        for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
        if (tarNumber(header, 148, 8, "checksum") !== sum) throw new PluginError("The tarball is damaged.");
        const type = String.fromCharCode(header[156] || 0x30);
        const size = tarNumber(header, 124, 12, "size");
        const dataStart = at + 512;
        if (dataStart + size > tar.length) throw new PluginError("The tarball is damaged.");
        const data = tar.subarray(dataStart, dataStart + size);
        at = dataStart + Math.ceil(size / 512) * 512;

        if (type === "x") { pax = paxRecords(data); continue; }
        if (type === "g") continue;
        if (type === "L") { longName = tarText(data, 0, data.length); continue; }
        const prefix = tarText(header, 345, 155);
        const own = tarText(header, 0, 100);
        const name = pax.path ?? longName ?? (prefix && tarText(header, 257, 5) === "ustar" ? `${prefix}/${own}` : own);
        const declared = pax.size !== undefined ? Number(pax.size) : size;
        pax = {};
        longName = undefined;
        if (declared !== size) throw new PluginError("The tarball is damaged.");
        sink.count();
        if (type !== "0" && type !== "5") throw new PluginError(`The tarball entry ${name.slice(0, 100)} is a link or a special file, which is not accepted.`);
        const entry = safeEntryName(type === "5" && !name.endsWith("/") ? `${name}/` : name);
        if (!entry) continue;
        if (type === "5") sink.directory(entry.path);
        else sink.file(entry.path, Buffer.from(data), (tarNumber(header, 100, 8, "mode") & 0o111) !== 0);
    }
};

/* ------------------------------------------------------------------------------------------------ root of the plugin */

const COMPONENT_NAMES = new Set(["skills", "commands", "agents", "hooks", ".claude-plugin", ".codex-plugin", ".claude", ".agents"]);

/**
 * The folder that holds the plugin inside an unpacked archive. A zip downloaded from a repository, or an npm tarball, wraps everything
 * in one folder (`repo-main/`, `package/`); that single wrapper is stepped into unless it is one of the plugin's own folders.
 */
export const archiveRoot = (unpacked: string): string => {
    const entries = readdirSync(unpacked, { withFileTypes: true });
    const only = entries.length === 1 ? entries[0] : undefined;
    if (only?.isDirectory() && !COMPONENT_NAMES.has(only.name)) {
        const inner = join(unpacked, only.name);
        if (statSync(inner).isDirectory()) return inner;
    }
    return unpacked;
};
