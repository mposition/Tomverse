import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImageCapabilitySystemPrompt,
  IMAGE_ARTIFACT_FRAGMENT,
  IMAGE_ARTIFACT_STATES,
  IMAGE_CAPABILITY_CORE,
  IMAGE_HANDOFF_FRAGMENTS,
  IMAGE_HANDOFF_STATES,
  resolveImageHandoffState,
} from "../lib/imageCapabilityPrompt.ts";
import { estimateTextTokens } from "../lib/chatTokenEstimate.ts";

const everyState = () => {
  const rows = [];
  for (const imageHandoff of IMAGE_HANDOFF_STATES) {
    for (const artifact of IMAGE_ARTIFACT_STATES) {
      rows.push({ imageHandoff, artifact });
    }
  }
  return rows;
};

const build = (input) => buildImageCapabilitySystemPrompt(input);

/* ------------------------------------------------------------------------ */
/* The state space                                                           */
/* ------------------------------------------------------------------------ */

test("12 input states produce 4 distinct texts", () => {
  const states = everyState();
  assert.equal(states.length, 12);
  const texts = new Set(states.map(build));
  // Two of the artifact states say nothing, and the three reachable handoff
  // states say the same thing because none of them tells the user how to reach
  // anything. So the 12 collapse to 2 handoff texts x 2 artifact texts.
  assert.equal(texts.size, 4);
});

test("every state produces a non-empty block", () => {
  for (const state of everyState()) {
    assert.ok(build(state).length > 0, JSON.stringify(state));
  }
});

test("the token range is 231 to 353", () => {
  const tokens = everyState().map((state) => estimateTextTokens(build(state)));
  assert.equal(Math.min(...tokens), 231);
  // The handoff paragraph is a prohibition that carries its own reason, and a
  // rule whose reason the model cannot see is the one it argues with. The
  // maximum is core + handoff + the file paragraph. The edit-limitation and
  // imperative-SVG variants that used to raise it were removed 2026-10-20
  // with the rule-based intent classifier.
  assert.equal(Math.max(...tokens), 353);
});

test("the minimum is the core alone and the maximum is handoff plus SVG", () => {
  assert.equal(
    build({ imageHandoff: "hidden", artifact: "unavailable" }),
    IMAGE_CAPABILITY_CORE
  );
  const max = build({ imageHandoff: "available", artifact: "available" });
  assert.ok(max.includes(IMAGE_HANDOFF_FRAGMENTS.available));
  assert.ok(max.includes(IMAGE_ARTIFACT_FRAGMENT));
});

test("the block does not depend on what the user typed or attached", () => {
  // Routing is decided by the LLM judgement (lib/chatImageIntent.ts). A stray
  // `intent` field must not bring back a text-dependent branch.
  for (const state of everyState()) {
    for (const intent of ["none", "edit_or_reference", "text_heavy_visual"]) {
      assert.equal(build({ ...state, intent }), build(state), `${intent}/${JSON.stringify(state)}`);
    }
  }
});

/* ------------------------------------------------------------------------ */
/* The file paragraph                                                        */
/* ------------------------------------------------------------------------ */

test("the file paragraph is present exactly when the file tool is available", () => {
  for (const imageHandoff of IMAGE_HANDOFF_STATES) {
    for (const artifact of IMAGE_ARTIFACT_STATES) {
      const text = build({ imageHandoff, artifact });
      assert.equal(
        text.includes(IMAGE_ARTIFACT_FRAGMENT),
        artifact === "available",
        `${imageHandoff}/${artifact}`
      );
    }
  }
});

test("paragraphs are joined by exactly one blank line", () => {
  const text = build({ imageHandoff: "available", artifact: "available" });
  assert.equal(text.includes("\n\n\n"), false);
  assert.equal(
    text,
    [IMAGE_CAPABILITY_CORE, IMAGE_HANDOFF_FRAGMENTS.available, IMAGE_ARTIFACT_FRAGMENT].join(
      "\n\n"
    )
  );
});

/* ------------------------------------------------------------------------ */
/* What the block may say                                                    */
/* ------------------------------------------------------------------------ */

test("with nothing available the block names no alternative and invents none", () => {
  const text = build({ imageHandoff: "hidden", artifact: "unavailable" });
  assert.equal(text.includes("tools menu"), false);
  assert.equal(text.includes("SVG"), false);
  assert.ok(text.includes("If no alternative is provided"));
  assert.ok(text.includes("without inventing or recommending another path"));
});

test("the SVG alternative appears only when the file tool is really available", () => {
  for (const artifact of IMAGE_ARTIFACT_STATES) {
    const text = build({ imageHandoff: "available", artifact });
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
    const text = build({ imageHandoff: "hidden", artifact });
    assert.equal(text.includes("Image generation exists in this app"), false);
    assert.equal(text.includes("separate workspace"), false);
  }
});

test("a Free account is given no route, and is not told about the plan either", () => {
  // The plan requirement is the control's job now: it renders locked, with the
  // requirement readable before the click. A sentence about paid plans in the
  // answer would be the app quoting its own pricing at someone who did not ask.
  const text = build({ imageHandoff: "upgrade", artifact: "available" });
  assert.equal(text.includes("tools menu"), false);
  assert.equal(text.includes("paid"), false);
  assert.ok(text.includes("never present it as an option"));
  // Free accounts do have the file tool, so the SVG paragraph is present --
  // this combination is real, not hypothetical.
  assert.ok(text.includes("SVG"));
  assert.equal(estimateTextTokens(text), 353);
});
