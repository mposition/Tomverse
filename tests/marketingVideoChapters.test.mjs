import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_CHAPTERS_AMBIGUOUS_REFUSAL_CODE,
  MARKETING_CHAPTERS_NO_LOCALE_REFUSAL_CODE,
  MARKETING_SHORT_VIDEO_MAX_SECONDS,
  MARKETING_VIDEO_CHAPTERS_MAX,
  MARKETING_VIDEO_CHAPTER_TITLE_MAX_CHARS,
  marketingVideoChapterIssues,
  marketingVideoChapterTimestamp,
  marketingVideoIsLongForm,
  marketingYoutubeChapterBlock,
  marketingYoutubeDraftText,
} from "@/lib/marketingVideoChapters";

// YouTube chapters on a long tutorial (owner decision 2026-11-07): YouTube's
// rules (https://support.google.com/youtube/answer/9884579) checked where the
// asset is submitted, and the list written by code, never by the model.

const chapter = (startSeconds, title = { en: `Part at ${startSeconds}` }) => ({ startSeconds, title });
const TUTORIAL = [chapter(0, { en: "What you will build" }), chapter(42, { en: "Ask three models" }), chapter(128, { en: "Compare the answers" })];

test("a five-minute tutorial's chapters pass: 0 first, ascending, every section ten seconds or more", () => {
  assert.deepEqual(marketingVideoChapterIssues(TUTORIAL, 300, ["en"]), []);
});

test("YouTube's boundaries hold exactly: ten seconds is enough, nine is not", () => {
  // Three chapters of exactly ten seconds in a thirty-second video.
  assert.deepEqual(marketingVideoChapterIssues([chapter(0), chapter(10), chapter(20)], 30, ["en"]), []);
  // A middle section of nine seconds.
  assert.notDeepEqual(marketingVideoChapterIssues([chapter(0), chapter(9), chapter(20)], 30, ["en"]), []);
  // The last section runs to the end: nine seconds there is too short too.
  assert.notDeepEqual(marketingVideoChapterIssues([chapter(0), chapter(10), chapter(21)], 30, ["en"]), []);
  // A start at or past the end is never valid.
  assert.notDeepEqual(marketingVideoChapterIssues([chapter(0), chapter(10), chapter(30)], 30, ["en"]), []);
});

test("the first chapter starts at 0, starts are strictly ascending whole seconds", () => {
  assert.notDeepEqual(marketingVideoChapterIssues([chapter(1), chapter(20), chapter(40)], 60, ["en"]), []);
  assert.notDeepEqual(marketingVideoChapterIssues([chapter(0), chapter(40), chapter(20)], 60, ["en"]), []);
  assert.notDeepEqual(marketingVideoChapterIssues([chapter(0), chapter(20), chapter(20)], 60, ["en"]), []);
  assert.notDeepEqual(marketingVideoChapterIssues([chapter(0), chapter(20.5), chapter(40)], 60, ["en"]), []);
  assert.notDeepEqual(marketingVideoChapterIssues([chapter(0), chapter(-10), chapter(40)], 60, ["en"]), []);
});

test("at least three chapters and at most twenty", () => {
  assert.notDeepEqual(marketingVideoChapterIssues([chapter(0), chapter(20)], 60, ["en"]), []);
  const twenty = Array.from({ length: MARKETING_VIDEO_CHAPTERS_MAX }, (_, index) => chapter(index * 10));
  assert.deepEqual(marketingVideoChapterIssues(twenty, 200, ["en"]), []);
  const twentyOne = Array.from({ length: MARKETING_VIDEO_CHAPTERS_MAX + 1 }, (_, index) => chapter(index * 10));
  assert.notDeepEqual(marketingVideoChapterIssues(twentyOne, 220, ["en"]), []);
});

test("only a video has chapters", () => {
  assert.deepEqual(marketingVideoChapterIssues(TUTORIAL, null, ["en"]), ["only a video has chapters"]);
});

test("every chapter is titled in each locale the asset has alt text for, on one line of at most 60 characters", () => {
  assert.notDeepEqual(marketingVideoChapterIssues(TUTORIAL, 300, ["en", "ko"]), []);
  const both = TUTORIAL.map((entry) => ({ ...entry, title: { ...entry.title, ko: "한국어 제목" } }));
  assert.deepEqual(marketingVideoChapterIssues(both, 300, ["en", "ko"]), []);
  // A title in a locale the asset is not posted in is allowed, and judged by the Guard.
  assert.deepEqual(marketingVideoChapterIssues(both, 300, ["en"]), []);

  const titled = (title) => marketingVideoChapterIssues([chapter(0, { en: title }), ...TUTORIAL.slice(1)], 300, ["en"]);
  assert.deepEqual(titled("a".repeat(MARKETING_VIDEO_CHAPTER_TITLE_MAX_CHARS)), []);
  assert.notDeepEqual(titled("a".repeat(MARKETING_VIDEO_CHAPTER_TITLE_MAX_CHARS + 1)), []);
  assert.notDeepEqual(titled(""), []);
  assert.notDeepEqual(titled(" Intro"), []);
  // A line break inside a title would add a line of its own to the list.
  assert.notDeepEqual(titled("Intro\n00:05 Fake"), []);
  assert.notDeepEqual(titled("Intro\tTab"), []);
  // The hashtags are bounded before the list is added, so a title cannot add one.
  assert.notDeepEqual(titled("Intro #Shorts"), []);
});

test("a timestamp is mm:ss, and h:mm:ss past an hour", () => {
  assert.equal(marketingVideoChapterTimestamp(0), "00:00");
  assert.equal(marketingVideoChapterTimestamp(9), "00:09");
  assert.equal(marketingVideoChapterTimestamp(245), "04:05");
  assert.equal(marketingVideoChapterTimestamp(3599), "59:59");
  assert.equal(marketingVideoChapterTimestamp(3723), "1:02:03");
});

test("the block is one `00:00 Title` line per chapter, in the asked locale only", () => {
  assert.equal(
    marketingYoutubeChapterBlock(TUTORIAL, "en"),
    "00:00 What you will build\n00:42 Ask three models\n02:08 Compare the answers",
  );
  // Half a list is not a list.
  assert.equal(marketingYoutubeChapterBlock(TUTORIAL, "ko"), null);
});

test("a YouTube draft gets the list at the end of its description; the title line stays first", () => {
  const draft = "Compare three AI answers in five minutes\nA walkthrough of Tomverse Review.\n\n#AI #Tomverse";
  const result = marketingYoutubeDraftText(draft, "en", [TUTORIAL]);
  assert.deepEqual(result, {
    text: `${draft}\n\n00:00 What you will build\n00:42 Ask three models\n02:08 Compare the answers`,
  });
  assert.equal(result.text.split("\n")[0], "Compare three AI answers in five minutes");
  // Trailing whitespace before the list is not doubled.
  assert.deepEqual(marketingYoutubeDraftText(`${draft}\n\n`, "en", [TUTORIAL]), result);
  // Without chapters the text is as it was.
  assert.deepEqual(marketingYoutubeDraftText(draft, "en", []), { text: draft });
  assert.deepEqual(marketingYoutubeDraftText(draft, "en", [[]]), { text: draft });
  // Chapters without the draft's locale are a refusal, not a silent omission.
  assert.deepEqual(marketingYoutubeDraftText(draft, "ko", [TUTORIAL]), { refused: MARKETING_CHAPTERS_NO_LOCALE_REFUSAL_CODE });
  // Two videos with chapters: no one list to write, so neither is dropped silently.
  assert.deepEqual(marketingYoutubeDraftText(draft, "en", [TUTORIAL, TUTORIAL]), { refused: MARKETING_CHAPTERS_AMBIGUOUS_REFUSAL_CODE });
});

test("long-form is a video with chapters or longer than sixty seconds", () => {
  assert.equal(MARKETING_SHORT_VIDEO_MAX_SECONDS, 60);
  assert.equal(marketingVideoIsLongForm({ durationSeconds: 45, chapters: null }), false);
  assert.equal(marketingVideoIsLongForm({ durationSeconds: 60, chapters: null }), false);
  assert.equal(marketingVideoIsLongForm({ durationSeconds: 61, chapters: null }), true);
  assert.equal(marketingVideoIsLongForm({ durationSeconds: 45, chapters: TUTORIAL }), true);
  assert.equal(marketingVideoIsLongForm({ durationSeconds: null, chapters: null }), false);
});
