import { Worker } from "node:worker_threads";

const MAX_ZIP_ENTRIES = 2_000;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const OFFICE_PARSE_TIMEOUT_MS = 12_000;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;

const OFFICE_ROOT_ENTRY: Record<string, string> = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        "word/document.xml",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        "xl/workbook.xml",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
        "ppt/presentation.xml",
    "application/vnd.oasis.opendocument.text": "content.xml",
    "application/vnd.oasis.opendocument.spreadsheet": "content.xml",
    "application/vnd.oasis.opendocument.presentation": "content.xml",
};

const findEndOfCentralDirectory = (buffer: Buffer) => {
    const minimumOffset = Math.max(0, buffer.length - 65_557);
    for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
        if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
            return offset;
        }
    }
    return -1;
};

export const assertSafeOfficeArchive = (
    buffer: Buffer,
    mediaType: string
) => {
    if (
        buffer.length < 22 ||
        buffer[0] !== 0x50 ||
        buffer[1] !== 0x4b
    ) {
        throw new Error("The Office file signature is invalid.");
    }

    const eocdOffset = findEndOfCentralDirectory(buffer);
    if (eocdOffset < 0) {
        throw new Error("The Office archive directory is invalid.");
    }

    const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
    const centralDirectoryDisk = buffer.readUInt16LE(eocdOffset + 6);
    const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
    const entryCount = buffer.readUInt16LE(eocdOffset + 10);
    const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
    const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

    if (
        diskNumber !== 0 ||
        centralDirectoryDisk !== 0 ||
        entriesOnDisk !== entryCount ||
        entryCount === 0 ||
        entryCount > MAX_ZIP_ENTRIES ||
        entryCount === 0xffff ||
        centralDirectorySize === 0xffffffff ||
        centralDirectoryOffset === 0xffffffff ||
        centralDirectoryOffset + centralDirectorySize > eocdOffset
    ) {
        throw new Error("The Office archive structure is not supported.");
    }

    const names = new Set<string>();
    let offset = centralDirectoryOffset;
    let totalCompressedBytes = 0;
    let totalUncompressedBytes = 0;

    for (let index = 0; index < entryCount; index += 1) {
        if (
            offset + 46 > buffer.length ||
            buffer.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_SIGNATURE
        ) {
            throw new Error("The Office archive entry is invalid.");
        }

        const flags = buffer.readUInt16LE(offset + 8);
        const compressedBytes = buffer.readUInt32LE(offset + 20);
        const uncompressedBytes = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const entryEnd =
            offset + 46 + nameLength + extraLength + commentLength;

        if (
            entryEnd > buffer.length ||
            compressedBytes === 0xffffffff ||
            uncompressedBytes === 0xffffffff ||
            (flags & 0x1) !== 0
        ) {
            throw new Error("Encrypted or ZIP64 Office files are not supported.");
        }

        const name = buffer
            .subarray(offset + 46, offset + 46 + nameLength)
            .toString("utf8")
            .replaceAll("\\", "/");
        if (
            !name ||
            name.startsWith("/") ||
            name.includes("\0") ||
            name.split("/").includes("..") ||
            names.has(name)
        ) {
            throw new Error("The Office archive contains an unsafe path.");
        }
        names.add(name);

        if (
            uncompressedBytes > MAX_ENTRY_UNCOMPRESSED_BYTES ||
            (compressedBytes === 0 && uncompressedBytes > 0) ||
            (compressedBytes > 0 &&
                uncompressedBytes / compressedBytes > MAX_COMPRESSION_RATIO)
        ) {
            throw new Error("The Office archive exceeds expansion limits.");
        }

        totalCompressedBytes += compressedBytes;
        totalUncompressedBytes += uncompressedBytes;
        if (
            totalUncompressedBytes > MAX_UNCOMPRESSED_BYTES ||
            (totalCompressedBytes > 0 &&
                totalUncompressedBytes / totalCompressedBytes >
                    MAX_COMPRESSION_RATIO)
        ) {
            throw new Error("The Office archive exceeds expansion limits.");
        }

        offset = entryEnd;
    }

    if (offset > centralDirectoryOffset + centralDirectorySize) {
        throw new Error("The Office archive directory size is invalid.");
    }

    const requiredEntry = OFFICE_ROOT_ENTRY[mediaType];
    if (!requiredEntry || !names.has(requiredEntry)) {
        throw new Error("The file contents do not match the declared Office type.");
    }

    if (
        mediaType.startsWith(
            "application/vnd.openxmlformats-officedocument."
        ) &&
        !names.has("[Content_Types].xml")
    ) {
        throw new Error("The OOXML content type manifest is missing.");
    }
};

const parserWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { OfficeParser } = require("officeparser");

(async () => {
    try {
        const document = await OfficeParser.parseOffice(
            Buffer.from(workerData.buffer),
            { extractAttachments: false, ocr: false }
        );
        const text = document.toText().trim();
        parentPort.postMessage({
            ok: true,
            text:
                text.length > workerData.maxCharacters
                    ? text.slice(0, workerData.maxCharacters) + "\\n\\n[Document truncated]"
                    : text,
        });
    } catch {
        parentPort.postMessage({ ok: false });
    }
})();
`;

export const parseOfficeSafely = async (
    buffer: Buffer,
    mediaType: string,
    maxCharacters: number
) => {
    assertSafeOfficeArchive(buffer, mediaType);

    const transferableBuffer = Uint8Array.from(buffer).buffer;
    const worker = new Worker(parserWorkerSource, {
        eval: true,
        workerData: {
            buffer: transferableBuffer,
            maxCharacters,
        },
        transferList: [transferableBuffer],
        resourceLimits: {
            maxOldGenerationSizeMb: 128,
            maxYoungGenerationSizeMb: 32,
            stackSizeMb: 4,
        },
    });

    return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, text?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            void worker.terminate();
            if (error) reject(error);
            else resolve(text || "");
        };

        const timeout = setTimeout(
            () => finish(new Error("Office parsing timed out.")),
            OFFICE_PARSE_TIMEOUT_MS
        );

        worker.once(
            "message",
            (result: { ok?: boolean; text?: unknown }) => {
                if (!result?.ok || typeof result.text !== "string") {
                    finish(new Error("The Office file could not be parsed."));
                    return;
                }
                finish(undefined, result.text);
            }
        );
        worker.once("error", () =>
            finish(new Error("The Office parser worker failed."))
        );
        worker.once("exit", (code) => {
            if (code !== 0) {
                finish(new Error("The Office parser worker stopped unexpectedly."));
            }
        });
    });
};
