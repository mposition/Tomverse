import assert from "node:assert/strict";
import { test } from "node:test";
import {
    readZipCentralDirectory,
} from "../lib/externalImportZipDirectory.ts";
import { classifyArchiveEntry } from "../lib/externalImportArchive.ts";

// docs/policy/external-conversation-import-and-memory.md §5.1–§5.2.
//
// Google Takeout writes every entry with a data descriptor, so its local file
// headers report size 0. These fixtures are built byte by byte rather than by
// a zip library: the whole point is what the header says, and a library that
// decides that for us would test itself.

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const DESCRIPTOR_SIG = 0x08074b50;
const ZIP64_SENTINEL = 0xffffffff;

const encoder = new TextEncoder();

const concat = (chunks) => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
};

const bytes = (length, write) => {
    const out = new Uint8Array(length);
    write(new DataView(out.buffer));
    return out;
};

/**
 * Builds a store-only archive. `dataDescriptor` reproduces what Takeout does:
 * the local header carries zeros and the sizes trail the entry data.
 */
function buildZip(entries, { dataDescriptor = false, comment = "" } = {}) {
    const flags = dataDescriptor ? 0x0808 : 0x0800;
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
        const name = encoder.encode(entry.name);
        const data = encoder.encode(entry.content ?? "");
        const declared = dataDescriptor ? 0 : data.length;

        const local = bytes(30, (view) => {
            view.setUint32(0, LOCAL_SIG, true);
            view.setUint16(4, 20, true);
            view.setUint16(6, flags, true);
            view.setUint16(8, 0, true); // stored
            view.setUint32(18, declared, true);
            view.setUint32(22, declared, true);
            view.setUint16(26, name.length, true);
        });
        parts.push(local, name, data);
        let written = local.length + name.length + data.length;

        if (dataDescriptor) {
            const descriptor = bytes(16, (view) => {
                view.setUint32(0, DESCRIPTOR_SIG, true);
                view.setUint32(8, data.length, true);
                view.setUint32(12, data.length, true);
            });
            parts.push(descriptor);
            written += descriptor.length;
        }

        const zip64 = entry.zip64 === true;
        const extra = zip64
            ? bytes(20, (view) => {
                  view.setUint16(0, 0x0001, true);
                  view.setUint16(2, 16, true);
                  view.setBigUint64(4, BigInt(data.length), true);
                  view.setBigUint64(12, BigInt(data.length), true);
              })
            : new Uint8Array(0);

        const header = bytes(46, (view) => {
            view.setUint32(0, CENTRAL_SIG, true);
            view.setUint16(4, 20, true);
            view.setUint16(6, 20, true);
            view.setUint16(8, flags, true);
            view.setUint16(10, 0, true);
            view.setUint32(20, zip64 ? ZIP64_SENTINEL : data.length, true);
            view.setUint32(24, zip64 ? ZIP64_SENTINEL : data.length, true);
            view.setUint16(28, name.length, true);
            view.setUint16(30, extra.length, true);
            view.setUint32(42, offset, true);
        });
        central.push(header, name, extra);
        offset += written;
    }

    const directory = concat(central);
    const commentBytes = encoder.encode(comment);
    const eocd = bytes(22, (view) => {
        view.setUint32(0, EOCD_SIG, true);
        view.setUint16(8, entries.length, true);
        view.setUint16(10, entries.length, true);
        view.setUint32(12, directory.length, true);
        view.setUint32(16, offset, true);
        view.setUint16(20, commentBytes.length, true);
    });

    return concat([...parts, directory, eocd, commentBytes]);
}

const readerFor = (archive) => async (start, end) =>
    archive.subarray(Math.max(0, start), Math.min(archive.length, end));

const directoryOf = (archive) =>
    readZipCentralDirectory(archive.length, readerFor(archive));

test("entry sizes come from the directory when local headers carry them", async () => {
    const archive = buildZip([
        { name: "Takeout/conversations.json", content: '[{"a":1}]' },
    ]);
    const directory = await directoryOf(archive);
    assert.equal(directory?.size, 1);
    assert.deepEqual(directory?.get("Takeout/conversations.json"), {
        name: "Takeout/conversations.json",
        uncompressedBytes: 9,
        compressedBytes: 9,
    });
});

test("a data-descriptor archive still yields the true sizes", async () => {
    // The regression: every Takeout entry sets flag bit 3, so the local header
    // says 0 and the walker used to skip the payload as `empty`.
    const payload = '[{"title":"x","time":"2026-01-01T00:00:00Z"}]';
    const archive = buildZip(
        [
            { name: "Takeout/Gemini/gems.html", content: "<html></html>" },
            { name: "Takeout/My Activity/Gemini Apps/activity.json", content: payload },
        ],
        { dataDescriptor: true }
    );

    const directory = await directoryOf(archive);
    const entry = directory?.get("Takeout/My Activity/Gemini Apps/activity.json");
    assert.equal(entry?.uncompressedBytes, payload.length);
    assert.notEqual(entry?.uncompressedBytes, 0);
});

test("the directory size is what turns the payload back into a parse", async () => {
    const payload = '[{"title":"x"}]';
    const archive = buildZip(
        [{ name: "Takeout/activity.json", content: payload }],
        { dataDescriptor: true }
    );
    const directory = await directoryOf(archive);
    const known = directory?.get("Takeout/activity.json");

    // What the worker did before: local header size, which is 0 here.
    assert.deepEqual(
        classifyArchiveEntry({ name: "Takeout/activity.json", uncompressedBytes: 0 }),
        { kind: "skip", reason: "empty" }
    );
    // What it does now.
    assert.deepEqual(
        classifyArchiveEntry({
            name: "Takeout/activity.json",
            uncompressedBytes: known.uncompressedBytes,
            compressedBytes: known.compressedBytes,
        }),
        { kind: "parse", role: "candidate" }
    );
});

test("a genuinely empty entry is still reported as empty", async () => {
    const archive = buildZip(
        [{ name: "Takeout/empty.json", content: "" }],
        { dataDescriptor: true }
    );
    const directory = await directoryOf(archive);
    const known = directory?.get("Takeout/empty.json");
    assert.equal(known?.uncompressedBytes, 0);
    assert.deepEqual(
        classifyArchiveEntry({
            name: "Takeout/empty.json",
            uncompressedBytes: known.uncompressedBytes,
        }),
        { kind: "skip", reason: "empty" }
    );
});

test("ZIP64 sizes are read from the entry's extra field", async () => {
    const payload = "0123456789";
    const archive = buildZip([
        { name: "big.json", content: payload, zip64: true },
    ]);
    const directory = await directoryOf(archive);
    assert.equal(directory?.get("big.json")?.uncompressedBytes, payload.length);
    assert.equal(directory?.get("big.json")?.compressedBytes, payload.length);
});

test("an archive comment does not hide the directory", async () => {
    const archive = buildZip([{ name: "a.json", content: "[]" }], {
        comment: "written by a tool that likes to sign its work",
    });
    assert.equal((await directoryOf(archive))?.get("a.json")?.uncompressedBytes, 2);
});

test("every entry of a multi-entry archive is present", async () => {
    const archive = buildZip(
        [
            { name: "a/one.json", content: "[1]" },
            { name: "a/two.json", content: "[1,2]" },
            { name: "a/photo.jpg", content: "xxxxxxx" },
        ],
        { dataDescriptor: true }
    );
    const directory = await directoryOf(archive);
    assert.equal(directory?.size, 3);
    assert.equal(directory?.get("a/two.json")?.uncompressedBytes, 5);
    assert.equal(directory?.get("a/photo.jpg")?.uncompressedBytes, 7);
});

test("an unreadable directory falls back rather than throwing", async () => {
    // Each of these must return null: the caller then uses local headers,
    // which is what it did before this module existed.
    const truncated = buildZip([{ name: "a.json", content: "[]" }]).subarray(0, 40);
    assert.equal(await directoryOf(truncated), null);

    assert.equal(await directoryOf(new Uint8Array(0)), null);
    assert.equal(await directoryOf(encoder.encode("not a zip at all")), null);

    const corrupted = buildZip([{ name: "a.json", content: "[]" }]);
    // Break the central directory signature, leaving the EOCD intact.
    const eocdAt = corrupted.length - 22;
    const cdAt = new DataView(corrupted.buffer, corrupted.byteOffset).getUint32(
        eocdAt + 16,
        true
    );
    corrupted[cdAt] = 0x00;
    assert.equal(await directoryOf(corrupted), null);

    const rejecting = buildZip([{ name: "a.json", content: "[]" }]);
    assert.equal(
        await readZipCentralDirectory(rejecting.length, async () => {
            throw new Error("range read failed");
        }),
        null
    );
});

test("an entry count past the archive limit declines the map", async () => {
    const archive = buildZip([{ name: "a.json", content: "[]" }]);
    assert.equal(
        await readZipCentralDirectory(archive.length, readerFor(archive), {
            ...(await import("../lib/externalImportLimits.ts"))
                .EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS,
            maxArchiveEntries: 0,
        }),
        null
    );
});
