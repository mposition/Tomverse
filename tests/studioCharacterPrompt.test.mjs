import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { estimatePromptTokens } from "../lib/chatTokenEstimate.ts";
import { IMAGE_PROMPT_MAX_TOKENS } from "../lib/imageGenerationPricing.ts";
import { STUDIO_CHARACTER_PRESETS, studioCharacterPrompt } from "../lib/studioCharacterPrompt.ts";

test("every character preset has its artwork and a brief inside the prompt limit", () => {
  assert.equal(new Set(STUDIO_CHARACTER_PRESETS.map(preset => preset.id)).size, STUDIO_CHARACTER_PRESETS.length);
  for (const preset of STUDIO_CHARACTER_PRESETS) {
    assert.ok(existsSync(new URL("../public/studio/" + preset.artwork, import.meta.url)), preset.artwork);
    const prompt = studioCharacterPrompt(preset);
    assert.ok(prompt.endsWith("Scene: " + preset.direction));
    assert.ok(estimatePromptTokens(prompt) <= IMAGE_PROMPT_MAX_TOKENS);
  }
});

test("a photoreal role asks for the person's likeness first and names its costume, prop and grade", () => {
  const roles = STUDIO_CHARACTER_PRESETS.filter(preset => "photoreal" in preset);
  assert.equal(roles.length, 8);
  for (const role of roles) {
    const prompt = studioCharacterPrompt(role);
    assert.match(prompt, /^Cast the person in the reference as the lead of this film\. Likeness comes first/);
    assert.match(prompt, /The reference gives identity only/);
    assert.match(prompt, /The role and genre must read at a glance/);
    // Each direction ends on the genre's own look, after the costume and the prop.
    assert.match(role.direction, /(film grade|noir cinematography)[^.]*\.$/);
    assert.ok(role.direction.split(". ").length >= 3, role.id);
  }
});

test("a stylised preset remakes the whole person in its medium instead of preserving a photographed face", () => {
  const media = STUDIO_CHARACTER_PRESETS.filter(preset => !("photoreal" in preset));
  assert.equal(media.length, 7);
  for (const medium of media) {
    const prompt = studioCharacterPrompt(medium);
    assert.match(prompt, /^Redesign the person in the reference as a character made entirely in this medium. Nothing photographic survives/);
    assert.match(prompt, /recognisable through design, not realism/);
    assert.doesNotMatch(prompt, /film still|Preserve their recognizable face/);
    assert.match(medium.direction, / look.$/);
  }
});
