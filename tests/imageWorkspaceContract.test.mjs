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

test("the image tab lists held models rather than only the runnable ones", () => {
  const source = read(IMAGE_TAB);
  // listEnabledImageModels() would silently drop a model held by the price
  // verification rule, and the catalogue would answer "why is this model
  // missing?" with nothing.
  assert.ok(
    source.includes("listImageModels"),
    `${IMAGE_TAB} must list every registered model via listImageModels().`
  );
  assert.ok(
    !source.includes("listEnabledImageModels"),
    `${IMAGE_TAB} must not filter to enabled models; a held model is stated as a hold, not omitted.`
  );
});

test("a held image model cannot be selected from the catalogue", () => {
  const source = read(IMAGE_TAB);
  assert.match(
    source,
    /disabled=\{held\}/,
    `${IMAGE_TAB} must disable held rows.`
  );
  assert.match(
    source,
    /if \(held\) return;/,
    `${IMAGE_TAB}'s click handler must refuse a held model even if the row becomes clickable.`
  );
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
