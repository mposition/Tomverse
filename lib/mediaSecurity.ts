import "server-only";

import { Worker } from "node:worker_threads";
import path from "node:path";

import { GifStructureError, readGifStructure } from "@/lib/gifStructure";

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
    "image/gif": (buffer) =>
        buffer.length >= 6 &&
        ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii")),
};

/** The media type the provider is sent, which is not always the one uploaded. */
export type NormalizableImageMediaType =
    | "image/png"
    | "image/jpeg"
    | "image/webp"
    | "image/gif";

/**
 * A GIF is re-encoded to PNG rather than forwarded: not every provider that
 * accepts images accepts GIF, and the one this product can guarantee about
 * the bytes it sends is that they are the still frame it validated.
 */
export const normalizedImageMediaType = (
    mediaType: NormalizableImageMediaType
) => (mediaType === "image/gif" ? "image/png" : mediaType);

/**
 * Raised for the one GIF failure a person can act on. Every other invalid
 * image is "invalid or unsupported"; this one has an answer -- export a still
 * frame -- and saying so is the difference between a dead end and a next
 * step.
 */
export class AnimatedImageError extends Error {
    constructor() {
        super("Animated images are not supported.");
        this.name = "AnimatedImageError";
    }
}

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
            "image/gif": "gif",
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
        if (expectedFormat === "png" || expectedFormat === "gif") {
            // A GIF leaves as a PNG: lossless, universally accepted by the
            // providers that take images at all, and no palette to preserve.
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

/**
 * Renders the pages of a PDF that carry no text, as JPEGs.
 *
 * A page with a text layer is skipped: its text is already extracted, and the
 * only pages worth an image are the ones that would otherwise vanish. Each
 * page is scaled so its longer side is at most `maxDimension`, which bounds
 * both the canvas memory and what an image embedding is billed for. The loop
 * stops at `maxImagePages` or when the output would pass `maxOutputBytes`.
 */
const pdfImagePagesWorkerSource = `
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

        const pages = [];
        const transfer = [];
        let totalBytes = 0;
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            if (pages.length >= workerData.maxImagePages) break;
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent({
                includeMarkedContent: false,
                disableNormalization: false,
            });
            const hasText = content.items.some(
                (item) => typeof item.str === "string" && item.str.trim() !== ""
            );
            if (!hasText) {
                const base = page.getViewport({ scale: 1 });
                const longest = Math.max(base.width, base.height);
                if (longest > 0 && Number.isFinite(longest)) {
                    const scale = Math.min(2, workerData.maxDimension / longest);
                    const viewport = page.getViewport({ scale });
                    const width = Math.max(1, Math.ceil(viewport.width));
                    const height = Math.max(1, Math.ceil(viewport.height));
                    const target = document.canvasFactory.create(width, height);
                    try {
                        await page.render({
                            canvasContext: target.context,
                            viewport,
                            canvas: target.canvas,
                        }).promise;
                        const jpeg = target.canvas.toBuffer("image/jpeg", 80);
                        if (totalBytes + jpeg.length > workerData.maxOutputBytes) {
                            page.cleanup();
                            break;
                        }
                        totalBytes += jpeg.length;
                        const bytes = Uint8Array.from(jpeg).buffer;
                        pages.push({ pageNumber, jpeg: bytes });
                        transfer.push(bytes);
                    } finally {
                        document.canvasFactory.destroy(target);
                    }
                }
            }
            page.cleanup();
        }
        await loadingTask.destroy();
        parentPort.postMessage({ ok: true, pages }, transfer);
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
    transferList: ArrayBuffer[],
    timeoutMs: number = MEDIA_PARSE_TIMEOUT_MS
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
            timeoutMs
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
    mediaType: NormalizableImageMediaType,
    maxOutputBytes: number
) {
    const signatureMatches = IMAGE_SIGNATURES[mediaType]?.(buffer) || false;
    if (!signatureMatches) {
        throw new Error("The image signature does not match its media type.");
    }

    if (mediaType === "image/gif") {
        // Decided here, from the block structure, rather than from whatever
        // page count the installed libvips happens to report -- see
        // `lib/gifStructure.ts`. A malformed GIF fails here too, before any
        // decoder touches it.
        let frames: number;
        try {
            frames = readGifStructure(
                new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
            ).frames;
        } catch (error) {
            throw error instanceof GifStructureError
                ? new Error("The GIF structure is invalid.")
                : error;
        }
        if (frames > 1) throw new AnimatedImageError();
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

/** Rendering is slower than reading text, and it is never on a user's turn. */
const PDF_IMAGE_PAGE_RENDER_TIMEOUT_MS = 45_000;

export const PDF_IMAGE_PAGE_LIMITS = {
    /** Scanned pages rendered per file; the rest stay unindexed. */
    maxImagePages: 20,
    /** The longer side of a rendered page, in pixels. */
    maxDimension: 1_024,
    /** All rendered pages of one file together. */
    maxOutputBytes: 16 * 1024 * 1024,
} as const;

export type PdfImagePage = { pageNumber: number; jpeg: Buffer };

/**
 * The text-less pages of a PDF as JPEGs, in page order.
 *
 * Runs in the same resource-limited worker as the other PDF readers. Throws
 * when the PDF cannot be parsed or rendered -- including on a host without the
 * canvas binary -- and the caller treats that as "no image pages", which is
 * the behaviour before this existed.
 */
export async function renderPdfImagePagesSafely(buffer: Buffer): Promise<PdfImagePage[]> {
    assertPdfSignature(buffer);

    const transferableBuffer = Uint8Array.from(buffer).buffer;
    const result = await runWorker<{
        ok: true;
        pages: Array<{ pageNumber: number; jpeg: ArrayBuffer }>;
    }>(
        pdfImagePagesWorkerSource,
        {
            buffer: transferableBuffer,
            maxPages: MAX_PDF_PAGES,
            ...PDF_IMAGE_PAGE_LIMITS,
            standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
            cMapUrl: PDF_CMAP_URL,
        },
        [transferableBuffer],
        PDF_IMAGE_PAGE_RENDER_TIMEOUT_MS
    );

    return result.pages
        .filter(
            (page) =>
                Number.isInteger(page.pageNumber) &&
                page.pageNumber >= 1 &&
                page.jpeg instanceof ArrayBuffer &&
                page.jpeg.byteLength > 0
        )
        .map((page) => ({ pageNumber: page.pageNumber, jpeg: Buffer.from(page.jpeg) }));
}
