import assert from "node:assert/strict";
import test from "node:test";
import {
  allowsImageHandoffReshow,
  classifyImageIntent,
  imageIntentDraftKey,
  IMAGE_INTENT_RESHOW_CHANGE_RATIO,
  l0ImageIntent,
  offersImageHandoffChip,
} from "../lib/imageIntentSignals.ts";
import {
  imageIntentAttachmentKind,
  normalizeComposerImageIntentInput,
  normalizeServerImageIntentInput,
} from "../lib/imageIntentInput.ts";

const IMAGE = [{ kind: "image" }];
const NONE = [];

const classify = (text, attachments = NONE) =>
  classifyImageIntent({ text, attachments });

/* ------------------------------------------------------------------------ */
/* The fixtures the report's parity table names                              */
/* ------------------------------------------------------------------------ */

test("an attached image plus an edit verb is an edit request", () => {
  assert.equal(classify("배경을 바꿔 줘", IMAGE), "edit_or_reference");
  assert.equal(classify("change the background of this", IMAGE), "edit_or_reference");
});

test("an attached image plus a question about it is analysis, not editing", () => {
  assert.equal(classify("이 사진을 설명해 줘", IMAGE), "analysis");
  assert.equal(classify("describe this photo for me", IMAGE), "analysis");
});

test("the same attachment produces different classes, so the attachment alone cannot decide", () => {
  // The report's central point: both turns carry one image and identical
  // descriptors. A rule that read the attachment would attach an editing
  // limitation to a question about a picture.
  const edit = classify("배경을 바꿔 줘", IMAGE);
  const describe = classify("이 사진을 설명해 줘", IMAGE);
  assert.notEqual(edit, describe);
});

test("a raster request with no attachment is raster generation", () => {
  assert.equal(classify("고양이 그림 그려 줘"), "raster_generation");
  assert.equal(classify("draw a picture of a cat"), "raster_generation");
});

test("a pictorial verb carries the request without a listed noun", () => {
  // The subject of a picture cannot be enumerated, so requiring a noun from a
  // closed list would answer every unlisted subject with silence.
  assert.equal(classify("draw a cat"), "raster_generation");
  assert.equal(classify("sketch a lighthouse at dusk"), "raster_generation");
  assert.equal(classify("고양이 그려 줘"), "raster_generation");
});

test("pictorial verbs used as idiom are not image requests", () => {
  assert.equal(classify("draw a conclusion from this data"), "none");
  assert.equal(classify("what conclusions can you draw from the table"), "none");
  assert.equal(classify("draw attention to the second paragraph"), "none");
  assert.equal(classify("that paints a picture of a struggling team"), "none");
  assert.equal(classify("let us draw up a plan for next quarter"), "none");
});

test("the text-heavy check runs before the pictorial verb", () => {
  // Otherwise "draw a flowchart" would be raster generation on the strength of
  // the verb, and the chip would offer the destination this class is waiting
  // on a decision about.
  assert.equal(classify("draw a flowchart of the release process"), "text_heavy_visual");
  assert.equal(classify("표를 그려 줘"), "text_heavy_visual");
});

test("a text-dense visual is its own class and never raster generation", () => {
  assert.equal(classify("인포그래픽으로 그려줘"), "text_heavy_visual");
  assert.equal(
    classify("고혈압에 좋은 음식을 이해하기쉽도록 인포그래픽으로 그려줘"),
    "text_heavy_visual"
  );
  assert.equal(classify("draw this as an infographic"), "text_heavy_visual");
  assert.equal(classify("make a flowchart of the process"), "text_heavy_visual");
});

test("text art asked for by name is not a substitution", () => {
  assert.equal(classify("ASCII 아트로 그려 줘"), "explicit_text_art");
  assert.equal(classify("draw it in ASCII art"), "explicit_text_art");
  assert.equal(classify("텍스트 아트로 만들어 줘"), "explicit_text_art");
});

test("ordinary questions are none", () => {
  assert.equal(classify("고혈압에 좋은 음식이 뭐야?"), "none");
  assert.equal(classify("summarise this article for me"), "none");
  assert.equal(classify("write a haiku about winter"), "none");
});

test("a draft shorter than the floor is none, whatever it looks like", () => {
  // A verdict after two keystrokes is noise, and on this surface it also
  // resizes the composer.
  assert.equal(classify("그림"), "none");
  assert.equal(classify("art"), "none");
});

/* ------------------------------------------------------------------------ */
/* Phrase-level judgement                                                    */
/* ------------------------------------------------------------------------ */

test("'설명해' is not a negative signal when the request is for a drawing", () => {
  // The rule that broke in review: a word-level negative would lose this.
  assert.equal(classify("그림으로 설명해 줘"), "raster_generation");
  assert.equal(classify("도식으로 설명해 줘"), "text_heavy_visual");
});

test("a noun with no producing verb is not a request to produce one", () => {
  assert.equal(classify("그림 같은 풍경을 글로 묘사해 주세요"), "none");
  assert.equal(classify("what makes a good illustration"), "none");
});

test("an attachment plus a producing request is a reference request, not a fresh run", () => {
  assert.equal(classify("이 스타일로 그림 그려 줘", IMAGE), "edit_or_reference");
  assert.equal(classify("draw a picture like this one", IMAGE), "edit_or_reference");
});

/* ------------------------------------------------------------------------ */
/* Consumers narrow one value; they do not classify separately               */
/* ------------------------------------------------------------------------ */

test("L0 keeps the two classes that change what the block says", () => {
  // Editing replaces the alternatives; a text-dense visual replaces the offer
  // with an instruction. Everything else shares the default branch.
  assert.equal(l0ImageIntent("edit_or_reference"), "edit_or_reference");
  assert.equal(l0ImageIntent("text_heavy_visual"), "text_heavy_visual");
  for (const other of ["raster_generation", "analysis", "explicit_text_art", "none"]) {
    assert.equal(l0ImageIntent(other), "none");
  }
});

test("the chip is still not offered for the class L0 now acts on", () => {
  // The block making the file and the composer offering the workspace are
  // different answers to the same request; only the first applies to a
  // text-dense visual.
  assert.equal(l0ImageIntent("text_heavy_visual"), "text_heavy_visual");
  assert.equal(offersImageHandoffChip("text_heavy_visual"), false);
});

test("the chip is offered for raster generation only", () => {
  assert.equal(offersImageHandoffChip("raster_generation"), true);
  for (const other of [
    "text_heavy_visual",
    "edit_or_reference",
    "analysis",
    "explicit_text_art",
    "none",
  ]) {
    assert.equal(offersImageHandoffChip(other), false);
  }
});

/* ------------------------------------------------------------------------ */
/* Adapter parity                                                            */
/* ------------------------------------------------------------------------ */

test("media types map to one of two kinds", () => {
  assert.equal(imageIntentAttachmentKind("image/png"), "image");
  assert.equal(imageIntentAttachmentKind("IMAGE/JPEG"), "image");
  assert.equal(imageIntentAttachmentKind("image/svg+xml"), "image");
  assert.equal(imageIntentAttachmentKind("application/pdf"), "other");
  assert.equal(imageIntentAttachmentKind(null), "other");
  assert.equal(imageIntentAttachmentKind(undefined), "other");
});

test("the server and composer adapters normalise to the same input and the same verdict", () => {
  // Both the normalised inputs and the verdicts are compared: two differently
  // shaped inputs that happen to agree today would pass a verdict-only test
  // and stop agreeing on the next attachment field either side adds.
  const fixtures = [
    {
      text: "배경을 바꿔 줘",
      server: [
        { handle: "att_1", name: "photo.png", mediaType: "image/png", byteSize: 1024 },
      ],
      composer: [
        { id: "a1", name: "photo.png", mediaType: "image/png", size: 1024, uploadId: "u1" },
      ],
      expected: "edit_or_reference",
    },
    {
      text: "이 사진을 설명해 줘",
      server: [
        { handle: "att_1", name: "photo.png", mediaType: "image/png", byteSize: 1024 },
      ],
      composer: [{ id: "a1", name: "photo.png", mediaType: "image/png", size: 1024 }],
      expected: "analysis",
    },
    {
      text: "고양이 그림 그려 줘",
      server: [],
      composer: [],
      expected: "raster_generation",
    },
    {
      text: "인포그래픽으로 그려 줘",
      server: [],
      composer: [],
      expected: "text_heavy_visual",
    },
    {
      text: "ASCII 아트로 그려 줘",
      server: [],
      composer: [],
      expected: "explicit_text_art",
    },
    {
      text: "draw a picture of a cat",
      server: [],
      composer: [],
      expected: "raster_generation",
    },
    {
      text: "change the background of this",
      server: [
        { handle: "att_1", name: "a.jpg", mediaType: "image/jpeg", byteSize: 10 },
      ],
      composer: [{ id: "a1", name: "a.jpg", mediaType: "image/jpeg", size: 10 }],
      expected: "edit_or_reference",
    },
    {
      text: "summarise the attached report",
      server: [
        { handle: "att_1", name: "r.pdf", mediaType: "application/pdf", byteSize: 10 },
      ],
      composer: [{ id: "a1", name: "r.pdf", mediaType: "application/pdf", size: 10 }],
      expected: "none",
    },
  ];

  for (const fixture of fixtures) {
    const serverInput = normalizeServerImageIntentInput({
      text: fixture.text,
      attachments: fixture.server,
    });
    const composerInput = normalizeComposerImageIntentInput({
      text: fixture.text,
      attachments: fixture.composer,
    });
    assert.deepEqual(
      serverInput,
      composerInput,
      `normalised inputs differ for: ${fixture.text}`
    );
    assert.equal(classifyImageIntent(serverInput), fixture.expected, fixture.text);
    assert.equal(classifyImageIntent(composerInput), fixture.expected, fixture.text);
  }
});

test("the normalised input carries nothing but text and attachment kinds", () => {
  const input = normalizeServerImageIntentInput({
    text: "hello",
    attachments: [
      { handle: "att_1", name: "secret-name.png", mediaType: "image/png", byteSize: 99 },
    ],
  });
  assert.deepEqual(Object.keys(input).sort(), ["attachments", "text"]);
  assert.deepEqual(input.attachments, [{ kind: "image" }]);
  assert.equal(JSON.stringify(input).includes("secret-name"), false);
});

/* ------------------------------------------------------------------------ */
/* Dismiss lifecycle                                                         */
/* ------------------------------------------------------------------------ */

test("the same draft never re-shows a dismissed chip", () => {
  const key = imageIntentDraftKey("  Draw A Cat Picture  ");
  assert.equal(key, "draw a cat picture");
  assert.equal(
    allowsImageHandoffReshow({
      dismissedKey: key,
      currentKey: imageIntentDraftKey("draw a cat picture"),
      dismissedIntent: "raster_generation",
      currentIntent: "raster_generation",
    }),
    false
  );
});

test("a substantially changed draft may re-show once", () => {
  const dismissedKey = "draw a cat";
  const grown = `${dismissedKey} in watercolour on a rainy street`;
  const moved =
    Math.abs(grown.length - dismissedKey.length) / grown.length;
  assert.ok(moved >= IMAGE_INTENT_RESHOW_CHANGE_RATIO);
  assert.equal(
    allowsImageHandoffReshow({
      dismissedKey,
      currentKey: grown,
      dismissedIntent: "raster_generation",
      currentIntent: "raster_generation",
    }),
    true
  );
});

test("a small edit does not re-show", () => {
  assert.equal(
    allowsImageHandoffReshow({
      dismissedKey: "draw a cat picture please",
      currentKey: "draw a cat picture please!",
      dismissedIntent: "raster_generation",
      currentIntent: "raster_generation",
    }),
    false
  );
});

test("a draft that newly becomes a raster request may re-show", () => {
  assert.equal(
    allowsImageHandoffReshow({
      dismissedKey: "tell me about cats",
      currentKey: "tell me about cats and draw a picture",
      dismissedIntent: "none",
      currentIntent: "raster_generation",
    }),
    true
  );
});

test("the re-show ratio is an experimental constant, not a hidden literal", () => {
  // Named and exported so moving it is one edit with a test on it. The report
  // records that there is no evidence behind 0.3 yet.
  assert.equal(typeof IMAGE_INTENT_RESHOW_CHANGE_RATIO, "number");
  assert.ok(
    IMAGE_INTENT_RESHOW_CHANGE_RATIO > 0 && IMAGE_INTENT_RESHOW_CHANGE_RATIO < 1
  );
});
