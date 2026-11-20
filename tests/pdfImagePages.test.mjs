// Rendering the text-less pages of a PDF as JPEGs (scanned pages).
//
// The renderer runs in the same worker sandbox as the other PDF readers, so
// these tests drive it with hand-built PDFs rather than a mock: one page of
// text, one page that is only an image. A page with a text layer must be left
// alone (its text is already extracted); only the page that would otherwise
// vanish from retrieval is worth an image.

import assert from "node:assert/strict";
import test from "node:test";

import { PDF_IMAGE_PAGE_LIMITS, renderPdfImagePagesSafely } from "../lib/mediaSecurity.ts";

const IMAGE_WIDTH = 64;
const IMAGE_HEIGHT = 48;

const rgbGradient = () => {
    const rgb = Buffer.alloc(IMAGE_WIDTH * IMAGE_HEIGHT * 3);
    for (let y = 0; y < IMAGE_HEIGHT; y += 1) {
        for (let x = 0; x < IMAGE_WIDTH; x += 1) {
            const offset = (y * IMAGE_WIDTH + x) * 3;
            rgb[offset] = x * 4;
            rgb[offset + 1] = y * 5;
            rgb[offset + 2] = 128;
        }
    }
    return rgb;
};

/**
 * A minimal valid PDF with a correct xref table.
 *
 * Each page is `{ kind: "text" | "image", width?, height? }`. Object numbers are
 * assigned up front so the page tree can name its kids, then every object is
 * written in order and its byte offset recorded for the cross-reference table.
 */
const buildPdf = (pages) => {
    const pageObjects = [];
    let next = 4; // 1 catalog, 2 page tree, 3 font
    for (const spec of pages) {
        const page = { spec, pageId: next, contentId: next + 1, imageId: null };
        next += 2;
        if (spec.kind === "image") {
            page.imageId = next;
            next += 1;
        }
        pageObjects.push(page);
    }

    const objects = new Map();
    objects.set(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"));
    objects.set(
        2,
        Buffer.from(
            `<< /Type /Pages /Kids [${pageObjects
                .map((page) => `${page.pageId} 0 R`)
                .join(" ")}] /Count ${pageObjects.length} >>`
        )
    );
    objects.set(3, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));

    for (const page of pageObjects) {
        const width = page.spec.width ?? 300;
        const height = page.spec.height ?? 200;
        const box = `/MediaBox [0 0 ${width} ${height}]`;
        if (page.spec.kind === "text") {
            objects.set(
                page.pageId,
                Buffer.from(
                    `<< /Type /Page /Parent 2 0 R ${box} /Contents ${page.contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`
                )
            );
            const content = "BT /F1 18 Tf 20 100 Td (Hello text page) Tj ET";
            objects.set(
                page.contentId,
                Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
            );
        } else {
            objects.set(
                page.pageId,
                Buffer.from(
                    `<< /Type /Page /Parent 2 0 R ${box} /Contents ${page.contentId} 0 R /Resources << /XObject << /Im1 ${page.imageId} 0 R >> >> >>`
                )
            );
            const draw = `q ${width} 0 0 ${height} 0 0 cm /Im1 Do Q`;
            objects.set(
                page.contentId,
                Buffer.from(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`)
            );
            const rgb = rgbGradient();
            objects.set(
                page.imageId,
                Buffer.concat([
                    Buffer.from(
                        `<< /Type /XObject /Subtype /Image /Width ${IMAGE_WIDTH} /Height ${IMAGE_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rgb.length} >>\nstream\n`
                    ),
                    rgb,
                    Buffer.from("\nendstream"),
                ])
            );
        }
    }

    const parts = [Buffer.from("%PDF-1.4\n")];
    const offsets = [];
    let position = parts[0].length;
    for (let id = 1; id < next; id += 1) {
        offsets.push(position);
        const written = Buffer.concat([
            Buffer.from(`${id} 0 obj\n`),
            objects.get(id),
            Buffer.from("\nendobj\n"),
        ]);
        parts.push(written);
        position += written.length;
    }

    let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
    xref += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`;
    parts.push(Buffer.from(xref));
    return Buffer.concat(parts);
};

/** The pixel size from a JPEG's start-of-frame marker. */
const jpegSize = (jpeg) => {
    let offset = 2;
    while (offset + 9 < jpeg.length) {
        if (jpeg[offset] !== 0xff) return null;
        const marker = jpeg[offset + 1];
        const length = jpeg.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: jpeg.readUInt16BE(offset + 5), width: jpeg.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
    }
    return null;
};

const JPEG_SIGNATURE = "ffd8ff";

test("only the text-less page of a two-page PDF is rendered", async () => {
    const pdf = buildPdf([{ kind: "text" }, { kind: "image" }]);
    const pages = await renderPdfImagePagesSafely(pdf);

    assert.equal(pages.length, 1);
    assert.equal(pages[0].pageNumber, 2);
    assert.ok(Buffer.isBuffer(pages[0].jpeg));
    assert.equal(pages[0].jpeg.subarray(0, 3).toString("hex"), JPEG_SIGNATURE);
    assert.ok(pages[0].jpeg.length > 100, "a real image, not an empty stub");
});

test("a PDF with only text yields no image pages", async () => {
    const pages = await renderPdfImagePagesSafely(buildPdf([{ kind: "text" }, { kind: "text" }]));
    assert.deepEqual(pages, []);
});

test("every scanned page is returned, in page order", async () => {
    const pdf = buildPdf([{ kind: "image" }, { kind: "text" }, { kind: "image" }, { kind: "image" }]);
    const pages = await renderPdfImagePagesSafely(pdf);
    assert.deepEqual(
        pages.map((page) => page.pageNumber),
        [1, 3, 4]
    );
    for (const page of pages) {
        assert.equal(page.jpeg.subarray(0, 3).toString("hex"), JPEG_SIGNATURE);
    }
});

test("a page is scaled so its longer side stays within maxDimension", async () => {
    const pdf = buildPdf([
        { kind: "image", width: 3000, height: 2000 },
        { kind: "image", width: 300, height: 200 },
    ]);
    const [large, small] = await renderPdfImagePagesSafely(pdf);

    const largeSize = jpegSize(large.jpeg);
    assert.ok(largeSize, "the large page is a readable JPEG");
    assert.ok(
        Math.max(largeSize.width, largeSize.height) <= PDF_IMAGE_PAGE_LIMITS.maxDimension,
        `rendered ${largeSize.width}x${largeSize.height}`
    );
    assert.ok(largeSize.width > largeSize.height, "the aspect ratio is kept");

    const smallSize = jpegSize(small.jpeg);
    assert.ok(smallSize);
    assert.ok(smallSize.width > smallSize.height);
    assert.ok(Math.max(smallSize.width, smallSize.height) <= PDF_IMAGE_PAGE_LIMITS.maxDimension);
});

test("the limits are positive bounds", () => {
    assert.ok(PDF_IMAGE_PAGE_LIMITS.maxImagePages >= 1);
    assert.ok(PDF_IMAGE_PAGE_LIMITS.maxDimension >= 256);
    assert.ok(PDF_IMAGE_PAGE_LIMITS.maxOutputBytes >= 1024 * 1024);
});

test("a buffer without a PDF signature is rejected", async () => {
    await assert.rejects(() => renderPdfImagePagesSafely(Buffer.from("not a pdf")));
});

test("a truncated PDF is rejected rather than returning partial pages", async () => {
    const pdf = buildPdf([{ kind: "text" }, { kind: "image" }]);
    await assert.rejects(() => renderPdfImagePagesSafely(pdf.subarray(0, 20)));
});
