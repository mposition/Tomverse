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
    {
      layout: "title",
      title: "Tomverse Review",
      subtitle: "2026년 제품 소개",
    },
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
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
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
    "Tomverse Review",
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
    "the note is not in the notes part",
  );
  assert.ok(
    !decode(files["ppt/slides/slide2.xml"]).includes("데모는 3분."),
    "the note leaked onto the slide",
  );
});

test("a slide with no notes gets no notes part", () => {
  const files = unzipSync(
    build({
      filename: "plain.pptx",
      format: "pptx",
      slides: [{ title: "One" }],
    }),
  );
  assert.equal(
    Object.keys(files).some((name) => name.startsWith("ppt/notesSlides/")),
    false,
  );
});

/**
 * The shape that says it is a placeholder must name one.
 *
 * `<a:spLocks noGrp="1"/>` beside an empty `<p:nvPr/>` is a shape claiming to
 * be a placeholder and then naming none. Every parser this repository tests
 * with accepts it; PowerPoint refuses the whole package -- "Sorry, PowerPoint
 * can't read ...", naming no part and offering no repair. It shipped because
 * nothing here could tell the two apart.
 */
test("a shape is either a real placeholder or a plain text box, never half of each", () => {
  const files = unzipSync(build(DECK));
  for (const [name, bytes] of Object.entries(files)) {
    if (
      !/^ppt\/(slides|notesSlides|slideMasters|slideLayouts|notesMasters)\//.test(
        name,
      )
    )
      continue;
    if (!name.endsWith(".xml")) continue;
    const xml = decode(bytes);
    for (const match of xml.matchAll(/<p:nvSpPr>([\s\S]*?)<\/p:nvSpPr>/g)) {
      const body = match[1];
      const locked = body.includes('spLocks noGrp="1"');
      const named = body.includes("<p:ph");
      const textBox = body.includes('txBox="1"');
      assert.equal(
        locked,
        named,
        `${name}: a shape locks against grouping (${locked}) but names a placeholder (${named})`,
      );
      if (!named) {
        assert.ok(
          textBox,
          `${name}: a non-placeholder shape is not marked as a text box`,
        );
      }
    }
  }
});

test("a notes slide's placeholder is one the notes master defines", () => {
  const files = unzipSync(build(DECK));
  const master = decode(files["ppt/notesMasters/notesMaster1.xml"]);
  assert.match(master, /<p:ph type="body" idx="1"\/>/);
  // Without it the notes slide inherits from nothing, and a reader looking for
  // the notes text frame finds none -- which is how this was caught.
  const notes = decode(files["ppt/notesSlides/notesSlide2.xml"]);
  assert.match(notes, /<p:ph type="body" idx="1"\/>/);
});

test("the presentation relates to the parts every producer writes", () => {
  const files = unzipSync(build(DECK));
  for (const part of [
    "ppt/presProps.xml",
    "ppt/viewProps.xml",
    "ppt/tableStyles.xml",
  ]) {
    assert.ok(files[part], `missing ${part}`);
  }
  const rels = decode(files["ppt/_rels/presentation.xml.rels"]);
  for (const kind of [
    "presProps",
    "viewProps",
    "tableStyles",
    "slideMaster",
    "notesMaster",
  ]) {
    assert.ok(rels.includes(`/${kind}"`), `no ${kind} relationship`);
  }
  // And the master defines the styles a slide inherits from.
  const master = decode(files["ppt/slideMasters/slideMaster1.xml"]);
  assert.match(master, /<p:txStyles>/);
});

test("relationship ids are the rId<n> form the ecosystem produces", () => {
  const files = unzipSync(build(DECK));
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".rels")) continue;
    for (const [, id] of decode(bytes).matchAll(/Id="([^"]+)"/g)) {
      assert.match(id, /^rId\d+$/, `${name}: ${id}`);
    }
  }
});

test("nothing in the deck is an external link or remote data", () => {
  const files = unzipSync(build(DECK));
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
    const xml = decode(bytes);
    assert.ok(!xml.includes("hlinkClick"), `${name} carries a hyperlink`);
    assert.ok(
      !/https?:\/\/(?!schemas|purl)/.test(xml),
      `${name} carries a URL`,
    );
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

test("each master owns its theme rather than sharing one part", () => {
  const files = unzipSync(build(DECK));
  const slideTheme = decode(
    files["ppt/slideMasters/_rels/slideMaster1.xml.rels"],
  ).match(/Target="\.\.\/(theme\/theme\d+\.xml)"/);
  const notesTheme = decode(
    files["ppt/notesMasters/_rels/notesMaster1.xml.rels"],
  ).match(/Target="\.\.\/(theme\/theme\d+\.xml)"/);
  assert.ok(slideTheme && notesTheme, "both masters relate to a theme");
  // A theme part is one master's theme in PowerPoint's model. Pointing both
  // masters at the same part is the confirmed cause of a deck it refuses to
  // open -- and it passes every schema and validator, so this is the only
  // thing standing between a reviewer and re-sharing the part.
  assert.notEqual(slideTheme[1], notesTheme[1]);
  assert.ok(files[`ppt/${notesTheme[1]}`], `missing ppt/${notesTheme[1]}`);
  const types = decode(files["[Content_Types].xml"]);
  assert.ok(
    types.includes(`PartName="/ppt/${notesTheme[1]}"`),
    "the second theme has no content type",
  );
});

test("a deck with no notes carries no notes master and no second theme", () => {
  const files = unzipSync(
    build({
      ...DECK,
      slides: DECK.slides.map((slide) =>
        Object.fromEntries(
          Object.entries(slide).filter(([key]) => key !== "notes"),
        ),
      ),
    }),
  );
  assert.equal(files["ppt/notesMasters/notesMaster1.xml"], undefined);
  // The override would name a part that is not there, which is a package the
  // reader rejects before it reads a single slide.
  assert.equal(files["ppt/theme/theme2.xml"], undefined);
  assert.ok(!decode(files["[Content_Types].xml"]).includes("theme2.xml"));
});
