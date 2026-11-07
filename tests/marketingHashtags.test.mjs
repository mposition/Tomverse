import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_HASHTAG_REMOVALS,
  marketingHashtagIsForbidden,
  marketingHashtagRange,
  marketingHashtags,
  marketingHashtagsWithinBounds,
} from "@/lib/marketingHashtags";

test("a tag is a # not glued to a word, an entity or a path", () => {
  assert.deepEqual(marketingHashtags("C# and &#35; and a/#b and x#y, then #AI and #인공지능 and #人工智慧_2"), [
    "AI",
    "인공지능",
    "人工智慧_2",
  ]);
});

test("a tag that names another company, the registry's or a known one, is forbidden", () => {
  for (const tag of ["ChatGPT", "chat_gpt", "ChatGPTalternative", "Claude", "Gemini", "Copilot", "DeepSeek", "제미나이", "클로드", "通義千問"]) {
    assert.equal(marketingHashtagIsForbidden(tag), true, tag);
  }
  // A registry name of three letters has to be the whole tag.
  assert.equal(marketingHashtagIsForbidden("Poe", ["Poe"]), true);
  assert.equal(marketingHashtagIsForbidden("poetry", ["Poe"]), false);
  assert.equal(marketingHashtagIsForbidden("AcmeChatTips", ["Acme Chat"]), true);
});

test("a tag that boasts or hints at a price is forbidden in every language", () => {
  for (const tag of ["best", "BestAI", "free", "freeAI", "AIforFree", "cheapest", "promo", "No1", "최고", "AI최고", "무료", "무료체험", "할인", "免费", "免費", "最好", "最佳AI", "優惠"]) {
    assert.equal(marketingHashtagIsForbidden(tag), true, tag);
  }
  for (const tag of ["AI", "AIassistant", "AIcomparison", "AItools", "techtok", "Shorts", "Tomverse", "인공지능", "AI비교", "人工智慧", "人工智能"]) {
    assert.equal(marketingHashtagIsForbidden(tag), false, tag);
  }
});

test("each platform has the owner's range, and an unknown platform takes none", () => {
  assert.deepEqual(marketingHashtagRange("instagram"), { min: 3, max: 5 });
  assert.deepEqual(marketingHashtagRange("threads"), { min: 0, max: 1 });
  assert.deepEqual(marketingHashtagRange("facebook"), { min: 0, max: 2 });
  assert.deepEqual(marketingHashtagRange("mastodon"), { min: 0, max: 0 });
  assert.deepEqual([...MARKETING_HASHTAG_REMOVALS], ["hashtag_forbidden", "hashtag_over_limit", "hashtag_shorts_on_long_form"]);
});

test("tags past the maximum are taken out after the forbidden ones, and the words stay as written", () => {
  const body = "Ask once,  read three answers.\n자세히 보기: 한 번에 비교.";
  const result = marketingHashtagsWithinBounds(`${body}\n\n#AI #ChatGPT #Tomverse #AItools #techtok #AIassistant #more`, "tiktok");
  assert.equal(result.text, `${body}\n\n#AI #Tomverse #AItools #techtok #AIassistant`);
  assert.deepEqual(result.removed, { hashtag_forbidden: 1, hashtag_over_limit: 1 });

  // A line of tags that is all gone leaves no trailing blank lines.
  const threads = marketingHashtagsWithinBounds(`${body}\n\n#AI\n#free #Tomverse`, "threads");
  assert.equal(threads.text, `${body}\n\n#AI`);
  assert.deepEqual(threads.removed, { hashtag_forbidden: 1, hashtag_over_limit: 1 });

  // A tag at the start of a line takes the space after it.
  assert.equal(marketingHashtagsWithinBounds("#best Three answers.", "facebook").text, "Three answers.");
});

test("YouTube keeps the title line and three tags in the description", () => {
  const result = marketingHashtagsWithinBounds(
    "Three answers to one question\nAsk once and compare.\n#Shorts #AI #Tomverse #AIcomparison",
    "youtube",
  );
  assert.equal(result.text, "Three answers to one question\nAsk once and compare.\n#Shorts #AI #Tomverse");
  assert.deepEqual(result.removed, { hashtag_over_limit: 1 });
});

test("a long-form video's post loses #Shorts in any spelling, and the tag after it takes its place (owner decision 2026-11-07)", () => {
  const text = "Compare three AI answers in five minutes\nA walkthrough.\n#Shorts #AI #Tomverse #AIcomparison";
  const long = marketingHashtagsWithinBounds(text, "youtube", [], { longForm: true });
  assert.equal(long.text, "Compare three AI answers in five minutes\nA walkthrough.\n#AI #Tomverse #AIcomparison");
  assert.deepEqual(long.removed, { hashtag_shorts_on_long_form: 1 });
  assert.equal(
    marketingHashtagsWithinBounds("Title\nBody.\n#AI #shorts #Tomverse", "youtube", [], { longForm: true }).text,
    "Title\nBody.\n#AI #Tomverse",
  );
  // A short keeps it, as before.
  assert.equal(marketingHashtagsWithinBounds(text, "youtube").text, "Compare three AI answers in five minutes\nA walkthrough.\n#Shorts #AI #Tomverse");
});

test("a text within bounds comes back unchanged, byte for byte", () => {
  const text = "Ask once.  \n\n#AI #Tomverse \n";
  assert.deepEqual(marketingHashtagsWithinBounds(text, "linkedin"), { text, removed: {} });
});
