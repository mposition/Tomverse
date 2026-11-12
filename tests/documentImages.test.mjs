import assert from "node:assert/strict";
import test from "node:test";

import { unzipSync } from "fflate";
import { PDFDocument, rgb } from "pdf-lib";
import sharp from "sharp";

import { resolveDocumentImages } from "../lib/documentImages.ts";
import { prepareFileConversion } from "../lib/fileConversion.ts";
import { admitFileConversionSpec } from "../lib/fileConversionCore.ts";
import {
  admitArchiveSpec,
  admitDocumentSpec,
} from "../lib/generatedArtifactCore.ts";
import { renderDocumentArtifact } from "../lib/generatedArtifactRenderers.ts";

// docs/policy/generated-artifacts.md section 16.
//
// A document can carry a picture from a file the user attached: a photograph,
// or a figure cut from a page of a PDF. Every assertion reads the written file
// back -- the package parts of a .docx, the pixels of a drawn PDF page.

const attachments = (entries) =>
  new Map(entries.map(([name, mediaType, bytes], index) => [`att_${index + 1}`, { name, mediaType, bytes }]));

/** A 400x200 picture: left half red, right half blue. */
const twoColour = async () =>
  new Uint8Array(
    await sharp({ create: { width: 400, height: 200, channels: 3, background: "#0000ff" } })
      .composite([
        {
          input: await sharp({ create: { width: 200, height: 200, channels: 3, background: "#ff0000" } })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer()
  );

/** A two-page PDF; page 2 has a green square in its top-left quarter. */
const figurePdf = async () => {
  const document = await PDFDocument.create();
  document.addPage([400, 400]);
  const page = document.addPage([400, 400]);
  page.drawRectangle({ x: 0, y: 200, width: 200, height: 200, color: rgb(0, 0.8, 0) });
  return new Uint8Array(await document.save());
};

const spec = (blocks, format = "docx") => {
  const admission = admitDocumentSpec({ filename: "report", format, blocks });
  assert.ok(admission.ok, admission.ok ? "" : admission.detail);
  return admission.spec;
};

const meanColour = async (bytes) => {
  const { channels } = await sharp(Buffer.from(bytes)).stats();
  return channels.slice(0, 3).map((channel) => Math.round(channel.mean));
};

/* ------------------------------------------------------------------------ */
/* Admission                                                                  */
/* ------------------------------------------------------------------------ */

test("an image block names a handle and a region inside the picture, nothing else", () => {
  for (const block of [
    { type: "image", attachment: "https://example.com/a.png" },
    { type: "image", attachment: "att_1", data: "iVBOR..." },
    { type: "image", attachment: "att_1", crop: { x: 0.6, y: 0, width: 0.6, height: 1 } },
    { type: "image", attachment: "att_1", widthPercent: 5 },
  ]) {
    const admission = admitDocumentSpec({ filename: "r", format: "docx", blocks: [block] });
    assert.equal(admission.ok, false, JSON.stringify(block));
  }
  const tooMany = admitDocumentSpec({
    filename: "r",
    format: "docx",
    blocks: Array.from({ length: 31 }, () => ({ type: "image", attachment: "att_1" })),
  });
  assert.equal(tooMany.ok, false);
});

test("an archive entry cannot carry an image block", () => {
  const admission = admitArchiveSpec({
    filename: "bundle",
    entries: [
      {
        path: "a.docx",
        documentFormat: "docx",
        blocks: [{ type: "image", attachment: "att_1" }],
      },
    ],
  });
  assert.equal(admission.ok, false);
});

/* ------------------------------------------------------------------------ */
/* Resolution                                                                 */
/* ------------------------------------------------------------------------ */

test("a crop takes the region the model named, from the upright picture", async () => {
  const files = attachments([["chart.png", "image/png", await twoColour()]]);
  const images = await resolveDocumentImages(
    spec([
      { type: "image", attachment: "att_1", crop: { x: 0, y: 0, width: 0.5, height: 1 } },
      { type: "image", attachment: "att_1", crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
      { type: "image", attachment: "att_1" },
    ]),
    files
  );
  const [left, right, whole] = [images.get(0), images.get(1), images.get(2)];
  assert.deepEqual([left.width, left.height, whole.width], [200, 200, 400]);
  const [red] = await meanColour(left.jpeg);
  const [, , blue] = await meanColour(right.jpeg);
  assert.ok(red > 200, "the left half is red");
  assert.ok(blue > 200, "the right half is blue");
  assert.equal((await sharp(Buffer.from(left.jpeg)).metadata()).format, "jpeg");
});

test("a figure is cut from the page of a PDF it is on", async () => {
  const files = attachments([["paper.pdf", "application/pdf", await figurePdf()]]);
  const images = await resolveDocumentImages(
    spec([{ type: "image", attachment: "att_1", page: 2, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } }]),
    files
  );
  const [r, g, b] = await meanColour(images.get(0).jpeg);
  assert.ok(g > 150 && r < 80 && b < 80, `the figure is green, got ${[r, g, b]}`);
});

test("a picture that cannot be found or placed is refused, with the reason", async () => {
  const files = attachments([
    ["paper.pdf", "application/pdf", await figurePdf()],
    ["notes.txt", "text/plain", new TextEncoder().encode("hi")],
    ["photo.png", "image/png", await twoColour()],
  ]);
  const cases = [
    [{ type: "image", attachment: "att_9" }, "SOURCE_MISSING"],
    [{ type: "image", attachment: "att_1", page: 5 }, "PAGES_INVALID"],
    [{ type: "image", attachment: "att_2" }, "SOURCE_TYPE"],
    [{ type: "image", attachment: "att_3", page: 2 }, "PAGES_INVALID"],
  ];
  for (const [block, code] of cases) {
    await assert.rejects(resolveDocumentImages(spec([block]), files), (error) => {
      assert.equal(error.code, code, JSON.stringify(block));
      return true;
    });
  }
});

/* ------------------------------------------------------------------------ */
/* Writers                                                                    */
/* ------------------------------------------------------------------------ */

test("a Word document carries the picture as a media part with an inline drawing", async () => {
  const files = attachments([["chart.png", "image/png", await twoColour()]]);
  const document = spec([
    { type: "heading", level: 1, text: "Results" },
    { type: "image", attachment: "att_1", caption: "Figure 1. Red and blue", widthPercent: 50 },
    { type: "paragraph", text: "After the figure." },
  ]);
  const rendered = renderDocumentArtifact(document, await resolveDocumentImages(document, files));
  const parts = unzipSync(rendered.bytes);
  const decode = (path) => new TextDecoder().decode(parts[path]);

  assert.ok(parts["word/media/image1.jpeg"]?.byteLength > 0);
  assert.match(decode("[Content_Types].xml"), /<Default Extension="jpeg" ContentType="image\/jpeg"\/>/);
  assert.match(decode("word/_rels/document.xml.rels"), /Id="rIdImage1"[^>]*Target="media\/image1\.jpeg"/);
  const body = decode("word/document.xml");
  assert.match(body, /<a:blip r:embed="rIdImage1"\/>/);
  assert.match(body, /Figure 1\. Red and blue/);
  // Half the text width: 9026 twips x 635 EMU / 2, never wider than 400 px.
  const [, cx, cy] = body.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/);
  assert.equal(Number(cx), Math.min(400 * 9525, Math.round((9026 * 635) / 2)));
  assert.equal(Number(cy), Math.round((Number(cx) * 200) / 400));
  // The figure stands between the heading and the paragraph, in order.
  assert.ok(body.indexOf("Results") < body.indexOf("r:embed") && body.indexOf("r:embed") < body.indexOf("After the figure."));
});

test("a PDF document draws the picture where the block stands", async () => {
  const files = attachments([["chart.png", "image/png", await twoColour()]]);
  const document = spec([{ type: "image", attachment: "att_1", caption: "Red and blue" }], "pdf");
  const rendered = renderDocumentArtifact(document, await resolveDocumentImages(document, files));
  const pdf = await PDFDocument.load(rendered.bytes);
  assert.equal(pdf.getPageCount(), 1);

  // Drawn back at 72 dpi: the picture is there, red on the left, blue on the right.
  const admission = admitFileConversionSpec({
    operation: "pdf_to_images",
    filename: "page",
    dpi: 72,
    sources: [{ attachment: "att_1" }],
  });
  const drawn = await (
    await prepareFileConversion(admission.spec, attachments([["d.pdf", "application/pdf", rendered.bytes]]))
  ).render();
  const { data, info } = await sharp(Buffer.from(drawn.bytes)).raw().toBuffer({ resolveWithObject: true });
  // 56 pt margin; a 400 px picture at 0.75 pt/px is 300 pt wide, centred.
  const x0 = Math.round((595.28 - 300) / 2);
  const at = (x, y) => {
    const offset = (y * info.width + x) * info.channels;
    return [data[offset], data[offset + 1], data[offset + 2]];
  };
  const y = 56 + 40;
  const [lr, , lb] = at(x0 + 40, y);
  const [rr, , rb] = at(x0 + 260, y);
  assert.ok(lr > 200 && lb < 80, `left is red, got ${at(x0 + 40, y)}`);
  assert.ok(rb > 200 && rr < 80, `right is blue, got ${at(x0 + 260, y)}`);
});

test("text formats say where a picture stood, and never link to one", async () => {
  const document = spec([{ type: "image", attachment: "att_1", caption: "Map" }], "md");
  const markdown = new TextDecoder().decode(renderDocumentArtifact(document).bytes);
  assert.match(markdown, /_\[Image: Map\]_/);
  assert.equal(/\]\(|https?:/.test(markdown), false);
});
