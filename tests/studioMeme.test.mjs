import assert from "node:assert/strict";
import { test } from "node:test";
import { estimatePromptTokens } from "../lib/chatTokenEstimate.ts";
import { IMAGE_PROMPT_MAX_TOKENS } from "../lib/imageGenerationPricing.ts";
import { studioMemeCaptionLines, studioMemePrompt } from "../lib/studioMeme.ts";

test("the meme brief asks for one reaction shot without lettering and carries the user's words as data", () => {
  const situation = 'They said "five minutes".', caption = "I run the café now";
  const plain = studioMemePrompt({ hasPhoto: false, situation: `  ${situation} `, caption });
  assert.match(plain, /^Create one original reaction image/);
  assert.match(plain, /One protagonist fills the frame/);
  assert.match(plain, /No letters, words, signs with writing/);
  assert.ok(plain.endsWith(JSON.stringify({ situation, captionContext: caption })));
  assert.match(studioMemePrompt({ hasPhoto: true, situation, caption }), /^Cast the person in the photo as the protagonist\. Likeness comes first/);
  // The longest input the form allows is shortened to fit, and the caption context survives whole.
  const longest = studioMemePrompt({ hasPhoto: true, situation: "가".repeat(500), caption: "나".repeat(55) });
  assert.ok(estimatePromptTokens(longest) <= IMAGE_PROMPT_MAX_TOKENS);
  assert.ok(longest.includes("나".repeat(55)) && longest.includes("가".repeat(100)));
});

test("a caption breaks into balanced lines at spaces, or between characters when it has none", () => {
  const width = line => line.length * 10;
  assert.deepEqual(studioMemeCaptionLines("  Short one ", width, 400), { lines: ["Short one"], scale: 1 });
  const two = studioMemeCaptionLines("I said five minutes. The meeting said ninety.", width, 300);
  assert.deepEqual(two.lines, ["I said five minutes.", "The meeting said ninety."]);
  assert.equal(two.scale, 1);
  const three = studioMemeCaptionLines("one two three four five six seven eight nine ten eleven twelve", width, 180);
  assert.equal(three.lines.length, 3);
  assert.equal(three.lines.join(" "), "one two three four five six seven eight nine ten eleven twelve");
  assert.ok(three.scale > .75);
  const han = studioMemeCaptionLines("等朋友等到我都成了店长等朋友等到我都成了店长", width, 120);
  assert.equal(han.lines.join(""), "等朋友等到我都成了店长等朋友等到我都成了店长");
  assert.ok(han.lines.length >= 2 && han.lines.every(line => line.length > 0));
  // One long word cannot break: it shrinks to fit instead.
  assert.deepEqual(studioMemeCaptionLines("Supercalifragilistic", width, 100), { lines: ["Supercalifragilistic"], scale: .5 });
});
