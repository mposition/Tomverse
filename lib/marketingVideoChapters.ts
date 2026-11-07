/**
 * YouTube chapters on a long video (owner decision 2026-11-07,
 * docs/policy/marketing-automation.md §7.3, §7.6).
 *
 * A long tutorial on YouTube is skimmed by its chapters: a list of start times
 * in the description, which YouTube turns into sections of the progress bar
 * (https://support.google.com/youtube/answer/9884579: the first time is 00:00,
 * at least three, in ascending order, each section at least ten seconds).
 *
 * The times are a fact about the file, so they come with the asset -- the media
 * CLI that cut the video knows them -- and never from the model that writes the
 * post: a model asked for timestamps would make them up. The asset submission
 * checks them here (and the database again, prisma/migrations/
 * 20261107120000_marketing_asset_chapters), and the draft intake appends the
 * block below to a YouTube draft before the Guard reads it and before the
 * envelope digest is taken, so a person approves the text that is sent.
 *
 * Imports nothing, so the generator service and an Admin component may load it.
 */

/** Fewest chapters YouTube shows. */
export const MARKETING_VIDEO_CHAPTERS_MIN = 3;
/** Most chapters one asset carries: a five-minute tutorial needs ten at most. */
export const MARKETING_VIDEO_CHAPTERS_MAX = 20;
/** Shortest section YouTube shows, the last one included (it runs to the end). */
export const MARKETING_VIDEO_CHAPTER_MIN_SECONDS = 10;
/** Longest chapter title, in UTF-16 code units: a progress-bar label, not a sentence. */
export const MARKETING_VIDEO_CHAPTER_TITLE_MAX_CHARS = 60;
/**
 * Longest video still treated as a Short. Longer, or carrying chapters, it is
 * long-form and its post never carries #Shorts. YouTube now takes Shorts up to
 * three minutes when they are square or vertical, but an asset records no frame
 * shape, so the line is the original sixty seconds: a vertical clip between one
 * and three minutes loses only a hashtag (YouTube classifies it by its frame),
 * while a horizontal two-minute tutorial is never labelled a Short.
 */
export const MARKETING_SHORT_VIDEO_MAX_SECONDS = 60;

export type MarketingVideoChapter = {
  readonly startSeconds: number;
  /** The title per locale. */
  readonly title: Readonly<Partial<Record<string, string>>>;
};

/** A character a one-line label cannot hold: C0 and C1 controls, line breaks among them. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/**
 * Whether a title is one line of 1 to 60 characters with nothing to trim and
 * no `#`: the list is added after the generator has bounded the hashtags, so a
 * title must not add one.
 */
export const marketingVideoChapterTitleValid = (title: string): boolean =>
  title.length >= 1 &&
  title.length <= MARKETING_VIDEO_CHAPTER_TITLE_MAX_CHARS &&
  title.trim() === title &&
  !title.includes("#") &&
  !CONTROL.test(title);

/**
 * What is wrong with an asset's chapters, or nothing. `altLocales` are the
 * locales the asset may be posted in (it has alt text there), and every chapter
 * needs a title in each of them: a post's description is in its own locale.
 */
export function marketingVideoChapterIssues(
  chapters: readonly MarketingVideoChapter[],
  durationSeconds: number | null,
  altLocales: readonly string[],
): string[] {
  const issues: string[] = [];
  if (durationSeconds === null) return ["only a video has chapters"];
  if (chapters.length < MARKETING_VIDEO_CHAPTERS_MIN || chapters.length > MARKETING_VIDEO_CHAPTERS_MAX) {
    issues.push(`a video has ${MARKETING_VIDEO_CHAPTERS_MIN} to ${MARKETING_VIDEO_CHAPTERS_MAX} chapters`);
  }
  chapters.forEach((chapter, index) => {
    if (!Number.isInteger(chapter.startSeconds) || chapter.startSeconds < 0) {
      issues.push(`chapter ${index + 1} does not start at a whole second`);
      return;
    }
    if (index === 0 && chapter.startSeconds !== 0) issues.push("the first chapter starts at 0");
    const previous = chapters[index - 1];
    if (previous && chapter.startSeconds - previous.startSeconds < MARKETING_VIDEO_CHAPTER_MIN_SECONDS) {
      issues.push(`chapter ${index} is shorter than ${MARKETING_VIDEO_CHAPTER_MIN_SECONDS} seconds`);
    }
    for (const locale of altLocales) {
      if (!Object.hasOwn(chapter.title, locale)) issues.push(`chapter ${index + 1} has no ${locale} title`);
    }
    for (const [locale, title] of Object.entries(chapter.title)) {
      if (typeof title !== "string" || !marketingVideoChapterTitleValid(title)) {
        issues.push(`chapter ${index + 1}'s ${locale} title is not one line of 1 to ${MARKETING_VIDEO_CHAPTER_TITLE_MAX_CHARS} characters`);
      }
    }
  });
  const last = chapters.at(-1);
  if (last && Number.isInteger(last.startSeconds) && durationSeconds - last.startSeconds < MARKETING_VIDEO_CHAPTER_MIN_SECONDS) {
    issues.push(`the last chapter is shorter than ${MARKETING_VIDEO_CHAPTER_MIN_SECONDS} seconds`);
  }
  return issues;
}

/** A start time as a chapter list writes it: 00:00, 04:05, or 1:02:03 past an hour. */
export function marketingVideoChapterTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

/**
 * The chapter list for one locale, one `00:00 Title` line per chapter. Null
 * when a chapter has no title in that locale: half a list is not a list.
 */
export function marketingYoutubeChapterBlock(chapters: readonly MarketingVideoChapter[], locale: string): string | null {
  const lines: string[] = [];
  for (const chapter of chapters) {
    const title = Object.hasOwn(chapter.title, locale) ? chapter.title[locale] : undefined;
    if (typeof title !== "string") return null;
    lines.push(`${marketingVideoChapterTimestamp(chapter.startSeconds)} ${title}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** The intake's refusal when a video's chapters have no title in the draft's locale. */
export const MARKETING_CHAPTERS_NO_LOCALE_REFUSAL_CODE = "intake_chapters_no_locale";
/** The intake's refusal when the draft and its chapter list are longer than a post may be. */
export const MARKETING_CHAPTERS_DO_NOT_FIT_REFUSAL_CODE = "intake_chapters_do_not_fit";

/**
 * A YouTube draft's text with its video's chapter list at the end of the
 * description, a blank line before it; the text as it was when the video has no
 * chapters. The title line is the text's first line and stays first.
 */
export function marketingYoutubeDraftText(
  text: string,
  locale: string,
  chapters: readonly MarketingVideoChapter[] | null,
): { readonly text: string } | { readonly refused: typeof MARKETING_CHAPTERS_NO_LOCALE_REFUSAL_CODE } {
  if (chapters === null || chapters.length === 0) return { text };
  const block = marketingYoutubeChapterBlock(chapters, locale);
  if (block === null) return { refused: MARKETING_CHAPTERS_NO_LOCALE_REFUSAL_CODE };
  // A draft that is only a title line still gets a description: the list.
  return { text: `${text.trimEnd()}\n\n${block}` };
}

/** Whether a video is long-form: it has chapters, or runs past a Short's length. */
export const marketingVideoIsLongForm = (video: {
  readonly durationSeconds: number | null;
  readonly chapters: readonly MarketingVideoChapter[] | null;
}): boolean =>
  (video.chapters !== null && video.chapters.length > 0) ||
  (video.durationSeconds !== null && video.durationSeconds > MARKETING_SHORT_VIDEO_MAX_SECONDS);
