import { deflateRawSync, gzipSync } from "node:zlib";

/**
 * A zip file and an npm tarball written by hand, so tests can hand the plugin installer archives that are well formed, or malformed
 * in one chosen way (an entry that climbs out, a link, a lie about a size or a checksum).
 */

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = (data: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
};

export type ZipItem = {
    name: string; data?: string | Buffer; mode?: number; method?: 0 | 8; flags?: number;
    /** What the table of contents claims, when it should differ from the truth. */
    claimedSize?: number; claimedCrc?: number;
};

export const zipOf = (items: ZipItem[]) => {
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const item of items) {
        const raw = Buffer.from(item.data ?? "");
        const method = item.method ?? 8;
        const stored = method === 8 ? deflateRawSync(raw) : raw;
        const name = Buffer.from(item.name);
        const crc = item.claimedCrc ?? crc32(raw);
        const size = item.claimedSize ?? raw.length;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(item.flags ?? 0, 6); local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14); local.writeUInt32LE(stored.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
        const head = Buffer.alloc(46);
        head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE((3 << 8) | 20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(item.flags ?? 0, 8);
        head.writeUInt16LE(method, 10); head.writeUInt32LE(crc, 16); head.writeUInt32LE(stored.length, 20); head.writeUInt32LE(size, 24);
        head.writeUInt16LE(name.length, 28); head.writeUInt32LE(((item.mode ?? (item.name.endsWith("/") ? 0o040755 : 0o100644)) << 16) >>> 0, 38); head.writeUInt32LE(offset, 42);
        locals.push(local, name, stored);
        central.push(head, name);
        offset += 30 + name.length + stored.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
};

export type TarItem = { name: string; data?: string; type?: string; mode?: number };
export const tarOf = (items: TarItem[]) => {
    const blocks: Buffer[] = [];
    for (const item of items) {
        const data = Buffer.from(item.data ?? "");
        const header = Buffer.alloc(512);
        header.write(item.name, 0, 100);
        header.write(`${(item.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
        header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
        header.write(item.type ?? "0", 156);
        header.write("ustar\0", 257);
        header.fill(0x20, 148, 156);
        let sum = 0;
        for (const byte of header) sum += byte;
        header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
        blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
};
