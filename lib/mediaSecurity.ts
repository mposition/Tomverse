import "server-only";

import { Worker } from "node:worker_threads";
import path from "node:path";

// pdfjs-dist needs a base path for its bundled standard (non-embedded) font
// metrics and CJK CMaps. Without these, parsing throws for any PDF that uses
// a standard font without embedding it — which is true of most real-world
// PDFs (receipts, exports, scans), even though a hand-built minimal PDF with
// no font resources at all can succeed without them. These must be plain
// filesystem paths, not "file://" URLs: pdfjs concatenates them with a
// filename via string interpolation (not `new URL()`) before handing the
// result to `fs.readFile`, and `fs.readFile` only parses `file://` when given
// an actual URL instance, not a string that merely looks like one.
//
// Resolved from process.cwd() rather than require.resolve()/import.meta.url:
// this module is bundled by Next.js's server build, and resolving a package
// path through the bundler's own module graph at runtime does not yield a
// real filesystem path (it broke the production build entirely). next start
// always runs with cwd at the project root, where node_modules lives.
const toPosixDirUrl = (dir: string) =>
    `${path
        .join(process.cwd(), "node_modules/pdfjs-dist", dir)
        .split(path.sep)
        .join("/")}/`;
const PDF_STANDARD_FONT_DATA_URL = toPosixDirUrl("standard_fonts");
const PDF_CMAP_URL = toPosixDirUrl("cmaps");

const MEDIA_PARSE_TIMEOUT_MS = 12_000;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_PDF_PAGES = 500;
const PDF_HEADER_SCAN_BYTES = 1_024;

const IMAGE_SIGNATURES: Record<string, (buffer: Buffer) => boolean> = {
    "image/png": (buffer) =>
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        ),
    "image/jpeg": (buffer) =>
        buffer.length >= 4 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff,
    "image/webp": (buffer) =>
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP",
};

const imageWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const sharp = require("sharp");

(async () => {
    try {
        const input = Buffer.from(workerData.buffer);
        const options = {
            failOn: "error",
            limitInputPixels: workerData.maxPixels,
            sequentialRead: true,
        };
        const metadata = await sharp(input, options).metadata();
        const expectedFormat = {
            "image/png": "png",
            "image/jpeg": "jpeg",
            "image/webp": "webp",
        }[workerData.mediaType];

        if (
            metadata.format !== expectedFormat ||
            !metadata.width ||
            !metadata.height ||
            metadata.width > workerData.maxDimension ||
            metadata.height > workerData.maxDimension ||
            metadata.width * metadata.height > workerData.maxPixels
        ) {
            throw new Error("Image metadata is invalid.");
        }

        let pipeline = sharp(input, options).rotate();
        if (expectedFormat === "png") {
            pipeline = pipeline.png({ compressionLevel: 9 });
        } else if (expectedFormat === "jpeg") {
            pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true });
        } else {
            pipeline = pipeline.webp({ quality: 90 });
        }

        const output = await pipeline.toBuffer();
        if (output.length === 0 || output.length > workerData.maxOutputBytes) {
            throw new Error("The normalized image is too large.");
        }
        const transferable = Uint8Array.from(output).buffer;
        parentPort.postMessage({ ok: true, buffer: transferable }, [transferable]);
    } catch {
        parentPort.postMessage({ ok: false });
    }
})();
`;

const pdfWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");

(async () => {
    let document;
    try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const loadingTask = pdfjs.getDocument({
            data: new Uint8Array(workerData.buffer),
            disableWorker: true,
            isEvalSupported: false,
            useSystemFonts: false,
            stopAtErrors: false,
            standardFontDataUrl: workerData.standardFontDataUrl,
            cMapUrl: workerData.cMapUrl,
            cMapPacked: true,
        });
        document = await loadingTask.promise;
        if (
            !Number.isInteger(document.numPages) ||
            document.numPages < 1 ||
            document.numPages > workerData.maxPages
        ) {
            throw new Error("PDF page count is invalid.");
        }

        const firstPage = await document.getPage(1);
        firstPage.cleanup();
        await loadingTask.destroy();
        parentPort.postMessage({ ok: true });
    } catch {
        if (document) {
            try {
                await document.cleanup();
            } catch {}
        }
        parentPort.postMessage({ ok: false });
    }
})();
`;

const pdfTextWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");

(async () => {
    let document;
    let loadingTask;
    try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        loadingTask = pdfjs.getDocument({
            data: new Uint8Array(workerData.buffer),
            disableWorker: true,
            isEvalSupported: false,
            useSystemFonts: false,
            stopAtErrors: false,
            standardFontDataUrl: workerData.standardFontDataUrl,
            cMapUrl: workerData.cMapUrl,
            cMapPacked: true,
        });
        document = await loadingTask.promise;
        if (
            !Number.isInteger(document.numPages) ||
            document.numPages < 1 ||
            document.numPages > workerData.maxPages
        ) {
            throw new Error("PDF page count is invalid.");
        }

        let text = "";
        const maxCharacters = Math.max(0, Number(workerData.maxCharacters) || 0);
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            if (text.length >= maxCharacters) break;
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent({
                includeMarkedContent: false,
                disableNormalization: false,
            });
            const pageText = content.items
                .map((item) => typeof item.str === "string" ? item.str : "")
                .filter(Boolean)
                .join(" ")
                .replace(/\\s+/g, " ")
                .trim();
            if (pageText) {
                text += (text ? "\\n\\n" : "") + "[Page " + pageNumber + "]\\n" + pageText;
                if (text.length > maxCharacters) {
                    text = text.slice(0, maxCharacters);
                    break;
                }
            }
            page.cleanup();
        }
        await loadingTask.destroy();
        parentPort.postMessage({ ok: true, text });
    } catch {
        if (document) {
            try {
                await document.cleanup();
            } catch {}
        }
        parentPort.postMessage({ ok: false });
    }
})();
`;

const assertPdfSignature = (buffer: Buffer) => {
    const headerWindow = buffer
        .subarray(0, Math.min(buffer.length, PDF_HEADER_SCAN_BYTES))
        .toString("latin1");
    if (!/%PDF-(1\.[0-7]|2\.0)/.test(headerWindow)) {
        throw new Error("The PDF signature is invalid.");
    }
};

const runWorker = <T>(
    source: string,
    workerData: Record<string, unknown>,
    transferList: ArrayBuffer[]
) =>
    new Promise<T>((resolve, reject) => {
        const worker = new Worker(source, {
            eval: true,
            workerData,
            transferList,
            resourceLimits: {
                maxOldGenerationSizeMb: 256,
                maxYoungGenerationSizeMb: 32,
                stackSizeMb: 4,
            },
        });
        let settled = false;
        const finish = (error?: Error, result?: T) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            void worker.terminate();
            if (error) reject(error);
            else resolve(result as T);
        };
        const timeout = setTimeout(
            () => finish(new Error("Media validation timed out.")),
            MEDIA_PARSE_TIMEOUT_MS
        );

        worker.once("message", (result: T & { ok?: boolean }) => {
            if (!result?.ok) {
                finish(new Error("Media validation failed."));
                return;
            }
            finish(undefined, result);
        });
        worker.once("error", () =>
            finish(new Error("Media validation worker failed."))
        );
        worker.once("exit", (code) => {
            if (code !== 0) {
                finish(new Error("Media validation worker stopped unexpectedly."));
            }
        });
    });

export async function normalizeImageSafely(
    buffer: Buffer,
    mediaType: "image/png" | "image/jpeg" | "image/webp",
    maxOutputBytes: number
) {
    const signatureMatches = IMAGE_SIGNATURES[mediaType]?.(buffer) || false;
    if (!signatureMatches) {
        throw new Error("The image signature does not match its media type.");
    }

    const transferableBuffer = Uint8Array.from(buffer).buffer;
    const result = await runWorker<{ ok: true; buffer: ArrayBuffer }>(
        imageWorkerSource,
        {
            buffer: transferableBuffer,
            mediaType,
            maxPixels: MAX_IMAGE_PIXELS,
            maxDimension: MAX_IMAGE_DIMENSION,
            maxOutputBytes,
        },
        [transferableBuffer]
    );
    return Buffer.from(result.buffer);
}

export async function validatePdfSafely(buffer: Buffer) {
    assertPdfSignature(buffer);

    const transferableBuffer = Uint8Array.from(buffer).buffer;
    await runWorker<{ ok: true }>(
        pdfWorkerSource,
        {
            buffer: transferableBuffer,
            maxPages: MAX_PDF_PAGES,
            standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
            cMapUrl: PDF_CMAP_URL,
        },
        [transferableBuffer]
    );
}

export async function extractPdfTextSafely(
    buffer: Buffer,
    maxCharacters: number
) {
    assertPdfSignature(buffer);

    const transferableBuffer = Uint8Array.from(buffer).buffer;
    const result = await runWorker<{ ok: true; text: string }>(
        pdfTextWorkerSource,
        {
            buffer: transferableBuffer,
            maxPages: MAX_PDF_PAGES,
            maxCharacters,
            standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
            cMapUrl: PDF_CMAP_URL,
        },
        [transferableBuffer]
    );

    return result.text.trim();
}
