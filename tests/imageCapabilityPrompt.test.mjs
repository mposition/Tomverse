import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImageCapabilitySystemPrompt,
  IMAGE_ARTIFACT_FRAGMENT,
  IMAGE_ARTIFACT_MAKE_FRAGMENT,
  IMAGE_ARTIFACT_STATES,
  IMAGE_CAPABILITY_CORE,
  IMAGE_EDIT_LIMITATION_FRAGMENT,
  IMAGE_HANDOFF_FRAGMENTS,
  IMAGE_HANDOFF_STATES,
  resolveImageHandoffState,
} from "../lib/imageCapabilityPrompt.ts";
import { estimateTextTokens } from "../lib/chatTokenEstimate.ts";

const INTENTS = ["none", "edit_or_reference", "text_heavy_visual"];

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

test("36 input states produce 7 distinct texts", () => {
  const states = everyState();
  assert.equal(states.length, 36);
  const texts = new Set(states.map(build));
  // Two of the artifact states say nothing, the edit branch ignores the other
  // two axes entirely, a text-dense request with no file tool says exactly
  // what any other request says -- and, since 2026-08-25, the three reachable
  // handoff states say the same thing too, because none of them tells the user
  // how to reach anything. So the 36 collapse to 7.
  assert.equal(texts.size, 7);
});

test("every state produces a non-empty block", () => {
  for (const state of everyState()) {
    assert.ok(build(state).length > 0, JSON.stringify(state));
  }
});

test("the token range is 231 to 409, and the edit branch is 302", () => {
  const tokens = everyState().map((state) => estimateTextTokens(build(state)));
  assert.equal(Math.min(...tokens), 231);
  // 396 -> 409 when the handoff paragraph became a prohibition. It is longer
  // than the direction it replaced because it carries its own reason, and a
  // rule whose reason the model cannot see is the one it argues with.
  assert.equal(Math.max(...tokens), 409);
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

/* ------------------------------------------------------------------------ */
/* The text-dense branch: make it, do not offer it                           */
/* ------------------------------------------------------------------------ */

test("a text-dense request with the file tool is told to make the file", () => {
  // The wasted turn this closes: a model holding the file tool answered an
  // infographic request with three format options and "which would you like?".
  const text = build({
    intent: "text_heavy_visual",
    imageHandoff: "available",
    artifact: "available",
  });
  assert.ok(text.includes(IMAGE_ARTIFACT_MAKE_FRAGMENT));
  assert.equal(text.includes(IMAGE_ARTIFACT_FRAGMENT), false);
  assert.ok(text.includes("Make it now"));
  assert.ok(text.includes("do not ask which format"));
  assert.ok(text.includes("do not offer a list of options"));
});

test("a raster request keeps the offer and is never told to make an SVG", () => {
  // Someone asking for a photograph wants neither an SVG nor a lecture on one.
  for (const imageHandoff of IMAGE_HANDOFF_STATES) {
    const text = build({ intent: "none", imageHandoff, artifact: "available" });
    assert.ok(text.includes(IMAGE_ARTIFACT_FRAGMENT), imageHandoff);
    assert.equal(text.includes(IMAGE_ARTIFACT_MAKE_FRAGMENT), false, imageHandoff);
  }
});

test("a text-dense request with no file tool is told to make nothing", () => {
  // Nothing to instruct, so the branch collapses to what any other request
  // gets and CORE's "state the limitation without inventing" is the answer.
  for (const artifact of ["unavailable", "sign_in"]) {
    const text = build({
      intent: "text_heavy_visual",
      imageHandoff: "available",
      artifact,
    });
    assert.equal(text.includes(IMAGE_ARTIFACT_MAKE_FRAGMENT), false, artifact);
    assert.equal(
      text,
      build({ intent: "none", imageHandoff: "available", artifact }),
      artifact
    );
  }
});

test("the imperative paragraph never reaches an attachment turn", () => {
  for (const artifact of IMAGE_ARTIFACT_STATES) {
    const text = build({
      intent: "edit_or_reference",
      imageHandoff: "available",
      artifact,
    });
    assert.equal(text.includes(IMAGE_ARTIFACT_MAKE_FRAGMENT), false, artifact);
  }
});

test("the imperative paragraph does not repeat the artifact block's ordering rule", () => {
  // Both blocks ride in the same request; "Call the tool first, then speak"
  // is already there, and a second copy is priced input that adds nothing.
  assert.equal(IMAGE_ARTIFACT_MAKE_FRAGMENT.includes("Call the tool"), false);
  assert.ok(IMAGE_ARTIFACT_MAKE_FRAGMENT.includes("after the file exists"));
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
});

test("the handoff paragraph forbids naming a destination the model cannot reach", () => {
  // The defect this replaced: the model listed the image workspace as option 4
  // of 4, the user picked it, and the model had to answer that it cannot go
  // there. The prohibition carries its own reason, which is the last clause.
  const text = IMAGE_HANDOFF_FRAGMENTS.available;
  assert.ok(text.includes("never present it as an option"));
  assert.ok(text.includes("you cannot navigate there"));
  assert.ok(text.includes("has been sent nowhere"));
  // And it no longer gives directions of any kind.
  assert.equal(text.includes("tools menu"), false);
  assert.equal(text.includes("Point the user"), false);
});

test("the three reachable states say the same thing", () => {
  // They differed only in what to tell the user about reachability, and the
  // model no longer tells them anything about it. The ladder still decides
  // what the *control* renders -- see the workspace contract -- which is why
  // resolveImageHandoffState is still three states and not a boolean.
  assert.equal(IMAGE_HANDOFF_FRAGMENTS.sign_in, IMAGE_HANDOFF_FRAGMENTS.available);
  assert.equal(IMAGE_HANDOFF_FRAGMENTS.upgrade, IMAGE_HANDOFF_FRAGMENTS.available);
  assert.equal(IMAGE_HANDOFF_FRAGMENTS.hidden, "");
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

test("a Free account is given no route, and is not told about the plan either", () => {
  // The plan requirement is the control's job now: it renders locked, with the
  // requirement readable before the click. A sentence about paid plans in the
  // answer would be the app quoting its own pricing at someone who did not ask.
  const text = build({ intent: "none", imageHandoff: "upgrade", artifact: "available" });
  assert.equal(text.includes("tools menu"), false);
  assert.equal(text.includes("paid"), false);
  assert.ok(text.includes("never present it as an option"));
  // Free accounts do have the file tool, so the SVG paragraph is present --
  // this combination is real, not hypothetical.
  assert.ok(text.includes("SVG"));
  assert.equal(estimateTextTokens(text), 364);
});
