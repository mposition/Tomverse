import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Static half of docs/ui-contracts/image-generation-workspace.md.
//
// The e2e spec proves what the user sees; these check the boundaries that are
// invisible at runtime until they have already been crossed -- an import that
// drags a chat-only surface into an image conversation, or an image tab that
// quietly stops listing the models it holds back. Both are cheap to break in a
// refactor and expensive to notice in review.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const WORKSPACE = "components/images/ImageGenerationWorkspace.tsx";
const IMAGE_TAB = "components/chat/ImageModelTabPanel.tsx";
const LAUNCHER = "components/chat/NewConversationLauncher.tsx";

test("the image workspace never mounts a chat-only surface", () => {
  const source = read(WORKSPACE);
  // Policy section 1: ChatInput, ChatApp and the comparison rail are chat
  // surfaces. The image workspace borrows the rail's principles, never its
  // component or its predicate.
  const forbidden = [
    "components/chat/ChatInput",
    "components/chat/ChatApp",
    "components/chat/ComparisonActionRail",
    "lib/comparisonReadiness",
    "shouldShowVisualStatus",
  ];
  for (const name of forbidden) {
    assert.ok(
      !source.includes(name),
      `${WORKSPACE} references ${name}; an image conversation must not mount or reuse chat comparison surfaces.`
    );
  }
});

test("the image tab lists only the models that can run", () => {
  // Owner decision 2026-11-13: a held model is operator state, stated in the
  // Admin catalogue, and a row a user cannot pick is noise in the picker. The
  // tab still reads the catalogue context (not the module-global registry), so
  // a runtime catalogue model is listed once it serves.
  const source = read(IMAGE_TAB);
  assert.match(source, /useImageModelCatalog\(\)/, `${IMAGE_TAB} must read the image catalogue context.`);
  assert.match(
    source,
    /\.filter\(\(model\) => model\.disabledReason === null\)/,
    `${IMAGE_TAB} must list only models with no disabled reason.`
  );
  assert.ok(!source.includes("listEnabledImageModels"), `${IMAGE_TAB} must not read the module-global registry.`);
});

test("each image tab row carries its owner's logo, like the chat list", () => {
  const source = read(IMAGE_TAB);
  assert.match(source, /<ModelLogo provider=\{brand\.owner\}/, `${IMAGE_TAB} must show the model owner's logo.`);
});

test("locked image entries stay clickable and route somewhere", () => {
  // Locked exposure is the whole point: hiding the entry, or disabling it with
  // no destination, is the failure mode this replaced.
  for (const path of [IMAGE_TAB, LAUNCHER]) {
    const source = read(path);
    assert.ok(
      source.includes("onLockedClick") || source.includes("onLockedImageClick"),
      `${path} must route a locked click to the sign-in or upgrade prompt.`
    );
    assert.ok(
      !/disabled=\{(?:Boolean\()?lock/.test(source),
      `${path} must not disable a locked entry; it states the requirement and routes instead.`
    );
  }
});

test("generated images always carry the AI-generated label", () => {
  const source = read(WORKSPACE);
  const occurrences = source.split("chat.imageGenerationAiLabel").length - 1;
  // Once in the alt text, once as the visible caption. Dropping either leaves
  // an AI image rendering as if it were not one.
  assert.ok(
    occurrences >= 2,
    `${WORKSPACE} must label a generated image in both its alt text and a visible caption (found ${occurrences}).`
  );
});

test("the image tab groups models by owner under a heading, like the chat list", () => {
  // Owner request 2026-11-13: the chat list groups by provider; the image tab
  // listed eight models in one run.
  const source = read(IMAGE_TAB);
  assert.match(source, /groupImageModelsByOwner\(models\)/, `${IMAGE_TAB} must group the runnable models by owner.`);
  assert.match(source, /data-testid="image-model-group"/, `${IMAGE_TAB} must render one group per owner.`);
  assert.match(source, /OWNER_LABELS\[group\.owner\]\.toUpperCase\(\)/, `${IMAGE_TAB} must head each group with the owner's brand.`);
});
