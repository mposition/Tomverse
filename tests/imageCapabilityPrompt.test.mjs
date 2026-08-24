import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImageCapabilitySystemPrompt,
  IMAGE_ARTIFACT_FRAGMENT,
  IMAGE_ARTIFACT_STATES,
  IMAGE_CAPABILITY_CORE,
  IMAGE_EDIT_LIMITATION_FRAGMENT,
  IMAGE_HANDOFF_FRAGMENTS,
  IMAGE_HANDOFF_STATES,
  resolveImageHandoffState,
} from "../lib/imageCapabilityPrompt.ts";
import { estimateTextTokens } from "../lib/chatTokenEstimate.ts";

const INTENTS = ["none", "edit_or_reference"];

const everyState = () => {
  const rows = [];
  for (const intent of INTENTS) {
    for (const imageHandoff of IMAGE_HANDOFF_STATES) {
      for (const artifact of IMAGE_ARTIFACT_STATES) {
        rows.push({ intent, imageHandoff, artifact });
      }
    }
  }
  return rows;
};

const build = (input) => buildImageCapabilitySystemPrompt(input);

/* ------------------------------------------------------------------------ */
/* The state space                                                           */
/* ------------------------------------------------------------------------ */

test("24 input states produce 9 distinct texts", () => {
  const states = everyState();
  assert.equal(states.length, 24);
  const texts = new Set(states.map(build));
  // Two of the artifact states say nothing, and the edit branch ignores the
  // other two axes entirely -- so the 24 collapse to 9.
  assert.equal(texts.size, 9);
});

test("every state produces a non-empty block", () => {
  for (const state of everyState()) {
    assert.ok(build(state).length > 0, JSON.stringify(state));
  }
});

test("the token range is 231 to 351, and the edit branch is 302", () => {
  const tokens = everyState().map((state) => estimateTextTokens(build(state)));
  assert.equal(Math.min(...tokens), 231);
  assert.equal(Math.max(...tokens), 351);
  assert.equal(
    estimateTextTokens(
      build({ intent: "edit_or_reference", imageHandoff: "available", artifact: "available" })
    ),
    302
  );
});

test("the minimum is the core alone and the maximum is handoff plus SVG", () => {
  assert.equal(
    build({ intent: "none", imageHandoff: "hidden", artifact: "unavailable" }),
    IMAGE_CAPABILITY_CORE
  );
  const max = build({
    intent: "none",
    imageHandoff: "available",
    artifact: "available",
  });
  assert.ok(max.includes(IMAGE_HANDOFF_FRAGMENTS.available));
  assert.ok(max.includes(IMAGE_ARTIFACT_FRAGMENT));
});

test("paragraphs are joined by exactly one blank line", () => {
  const text = build({
    intent: "none",
    imageHandoff: "available",
    artifact: "available",
  });
  assert.equal(text.includes("\n\n\n"), false);
  assert.equal(
    text,
    [IMAGE_CAPABILITY_CORE, IMAGE_HANDOFF_FRAGMENTS.available, IMAGE_ARTIFACT_FRAGMENT].join(
      "\n\n"
    )
  );
});

/* ------------------------------------------------------------------------ */
/* Exclusion, not correction                                                 */
/* ------------------------------------------------------------------------ */

test("the edit branch carries no handoff and no SVG paragraph, in any state", () => {
  for (const imageHandoff of IMAGE_HANDOFF_STATES) {
    for (const artifact of IMAGE_ARTIFACT_STATES) {
      const text = build({ intent: "edit_or_reference", imageHandoff, artifact });
      assert.equal(
        text,
        `${IMAGE_CAPABILITY_CORE}\n\n${IMAGE_EDIT_LIMITATION_FRAGMENT}`,
        `${imageHandoff}/${artifact}`
      );
      assert.equal(text.includes(IMAGE_ARTIFACT_FRAGMENT), false);
      assert.equal(text.includes("tools menu"), false);
    }
  }
});

test("an analysis turn is not given the editing limitation", () => {
  // D takes the `none` branch through l0ImageIntent, so a question about an
  // attached picture never collects a notice about editing one.
  const text = build({ intent: "none", imageHandoff: "available", artifact: "available" });
  assert.equal(text.includes(IMAGE_EDIT_LIMITATION_FRAGMENT), false);
});

/* ------------------------------------------------------------------------ */
/* What the block may say                                                    */
/* ------------------------------------------------------------------------ */

test("with nothing available the block names no alternative and invents none", () => {
  const text = build({ intent: "none", imageHandoff: "hidden", artifact: "unavailable" });
  assert.equal(text.includes("tools menu"), false);
  assert.equal(text.includes("SVG"), false);
  assert.ok(text.includes("If no alternative is provided"));
  assert.ok(text.includes("without inventing or recommending another path"));
});

test("the SVG alternative appears only when the file tool is really available", () => {
  for (const artifact of IMAGE_ARTIFACT_STATES) {
    const text = build({ intent: "none", imageHandoff: "available", artifact });
    assert.equal(text.includes("SVG"), artifact === "available", artifact);
  }
});

test("the core denies the raster workflow, not images in general", () => {
  // Otherwise the same request would both refuse to make an image and offer to
  // create an SVG, which is a contradiction rather than an instruction.
  assert.ok(IMAGE_CAPABILITY_CORE.includes("raster image-generation workflow"));
  assert.ok(IMAGE_CAPABILITY_CORE.includes("inside the message"));
  assert.equal(IMAGE_CAPABILITY_CORE.includes("You cannot generate images"), false);
  assert.ok(IMAGE_ARTIFACT_FRAGMENT.includes("downloads, not a picture drawn inside the message"));
});

test("text art asked for by name stays permitted", () => {
  assert.ok(IMAGE_CAPABILITY_CORE.includes("The one exception is an explicit"));
  assert.ok(IMAGE_CAPABILITY_CORE.includes("ASCII art"));
});

test("the block forbids the substitution that caused this feature", () => {
  assert.ok(IMAGE_CAPABILITY_CORE.includes("Never substitute a drawing made of text characters"));
  // A table is still a table: ordinary formatting is not a drawing.
  assert.ok(IMAGE_CAPABILITY_CORE.includes("a table is a table, not a drawing"));
});

test("no unverified quality claim about the image models", () => {
  const everyFragment = [
    IMAGE_CAPABILITY_CORE,
    ...Object.values(IMAGE_HANDOFF_FRAGMENTS),
    IMAGE_ARTIFACT_FRAGMENT,
    IMAGE_EDIT_LIMITATION_FRAGMENT,
  ].join("\n");
  for (const claim of ["badly", "poorly", "not good at", "worse", "low quality"]) {
    assert.equal(everyFragment.includes(claim), false, claim);
  }
  // The text-dense case is stated as product scope instead.
  assert.ok(IMAGE_HANDOFF_FRAGMENTS.available.includes("outside that"));
  assert.ok(IMAGE_HANDOFF_FRAGMENTS.available.includes("current scope"));
});

test("the editing limitation is scoped to the workspace, not to the whole app", () => {
  assert.ok(IMAGE_EDIT_LIMITATION_FRAGMENT.includes("image-generation\nworkspace cannot edit"));
  assert.equal(IMAGE_EDIT_LIMITATION_FRAGMENT.includes("anywhere in this app"), false);
  // And it must not close the door on reading the attachment.
  assert.ok(
    IMAGE_EDIT_LIMITATION_FRAGMENT.includes("You may still look at the attachment")
  );
});

/* ------------------------------------------------------------------------ */
/* The handoff ladder                                                        */
/* ------------------------------------------------------------------------ */

test("the handoff state follows the flag, then sign-in, then the plan", () => {
  assert.equal(
    resolveImageHandoffState({
      flagEnabled: false,
      isAuthenticated: true,
      planAllowsImageGeneration: true,
    }),
    "hidden"
  );
  assert.equal(
    resolveImageHandoffState({
      flagEnabled: true,
      isAuthenticated: false,
      planAllowsImageGeneration: false,
    }),
    "sign_in"
  );
  assert.equal(
    resolveImageHandoffState({
      flagEnabled: true,
      isAuthenticated: true,
      planAllowsImageGeneration: false,
    }),
    "upgrade"
  );
  assert.equal(
    resolveImageHandoffState({
      flagEnabled: true,
      isAuthenticated: true,
      planAllowsImageGeneration: true,
    }),
    "available"
  );
});

test("with the flag off the block never mentions the workspace", () => {
  for (const artifact of IMAGE_ARTIFACT_STATES) {
    const text = build({ intent: "none", imageHandoff: "hidden", artifact });
    assert.equal(text.includes("Image generation exists in this app"), false);
    assert.equal(text.includes("separate workspace"), false);
  }
});

test("a Free account is told the plan requirement and no route past it", () => {
  const text = build({ intent: "none", imageHandoff: "upgrade", artifact: "available" });
  assert.ok(text.includes("included only in the paid"));
  assert.equal(text.includes("tools menu"), false);
  // Free accounts do have the file tool, so the SVG paragraph is present --
  // this combination is real, not hypothetical.
  assert.ok(text.includes("SVG"));
  assert.equal(estimateTextTokens(text), 317);
});
