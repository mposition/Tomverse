import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { unzipSync } from "fflate";

import { admitPresentationSpec } from "../lib/generatedArtifactCore.ts";
import { renderPresentationPptx } from "../lib/generatedArtifactPptx.ts";

// docs/policy/generated-artifacts.md sections 3 and 4.

const require = createRequire(import.meta.url);
const { OfficeParser } = require("officeparser");

const decode = (bytes) => new TextDecoder().decode(bytes);

const build = (spec) => {
  const admission = admitPresentationSpec(spec);
  assert.equal(admission.ok, true, JSON.stringify(admission));
  return renderPresentationPptx(admission.spec);
};

const DECK = {
  filename: "제품_소개.pptx",
  format: "pptx",
  slides: [
    { layout: "title", title: "Tomverse Insight", subtitle: "2026년 제품 소개" },
    {
      layout: "titleAndContent",
      title: "핵심 기능",
      bullets: ["멀티 모델 비교", "AI 리뷰", "파일 생성"],
      notes: "데모는 3분.",
    },
    { layout: "sectionHeader", title: "가격" },
  ],
};

test("the package holds every part PowerPoint requires", () => {
  const files = unzipSync(build(DECK));
  for (const part of [
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
    "ppt/slideMasters/slideMaster1.xml",
    "ppt/slideLayouts/slideLayout1.xml",
    "ppt/theme/theme1.xml",
    "ppt/slides/slide1.xml",
    "ppt/slides/slide2.xml",
    "ppt/slides/slide3.xml",
  ]) {
    assert.ok(files[part], `missing ${part}`);
  }
});

test("one slide part per slide, and no more", () => {
  const files = unzipSync(build(DECK));
  const slides = Object.keys(files).filter((name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name)
  );
  assert.equal(slides.length, DECK.slides.length);
});

test("an independent reader gets every slide's words back", async () => {
  const document = await OfficeParser.parseOffice(Buffer.from(build(DECK)), {
    extractAttachments: false,
    ocr: false,
  });
  const text = document.toText();
  for (const expected of [
    "Tomverse Insight",
    "2026년 제품 소개",
    "핵심 기능",
    "멀티 모델 비교",
    "가격",
  ]) {
    assert.ok(text.includes(expected), `missing: ${expected}`);
  }
});

// Speaker notes belong in the file and never on the slide. A deck that printed
// them on the slide would put the presenter's private aside on the screen.
test("notes become a notes part, not slide text", () => {
  const files = unzipSync(build(DECK));
  assert.ok(files["ppt/notesSlides/notesSlide2.xml"], "no notes part");
  assert.ok(
    decode(files["ppt/notesSlides/notesSlide2.xml"]).includes("데모는 3분."),
    "the note is not in the notes part"
  );
  assert.ok(
    !decode(files["ppt/slides/slide2.xml"]).includes("데모는 3분."),
    "the note leaked onto the slide"
  );
});

test("a slide with no notes gets no notes part", () => {
  const files = unzipSync(
    build({
      filename: "plain.pptx",
      format: "pptx",
      slides: [{ title: "One" }],
    })
  );
  assert.equal(
    Object.keys(files).some((name) => name.startsWith("ppt/notesSlides/")),
    false
  );
});

test("nothing in the deck is an external link or remote data", () => {
  const files = unzipSync(build(DECK));
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
    const xml = decode(bytes);
    assert.ok(!xml.includes("hlinkClick"), `${name} carries a hyperlink`);
    assert.ok(!/https?:\/\/(?!schemas|purl)/.test(xml), `${name} carries a URL`);
  }
});

test("a deck with no slides is refused before a file exists", () => {
  const admission = admitPresentationSpec({
    filename: "empty.pptx",
    format: "pptx",
    slides: [],
  });
  assert.equal(admission.ok, false);
});

test("the bytes are deterministic, so a replay cannot differ", () => {
  assert.deepEqual(build(DECK), build(DECK));
});
