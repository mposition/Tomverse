/**
 * What kind of image request this turn is -- decided once, for two consumers.
 *
 * Report: `.github/audits/image-intent-auto-switch-2026-08-24.md` §5.1, §5.3.
 * Policy: `docs/policy/image-generation.md` §13.
 *
 * ## Why one module rather than two
 *
 * Two surfaces need this answer and they must not disagree:
 *
 *   L0  the chat turn's image-capability system block, on the server;
 *   L1  the composer's handoff chip, on the client, while somebody types.
 *
 * A second dictionary on the other side is how the chip comes to appear on
 * turns the block says nothing about, and the reverse. So the rules live here,
 * once, and each consumer *narrows* the same value rather than deciding it:
 * `l0ImageIntent()` asks only whether this is an edit, `offersImageHandoffChip()`
 * asks only whether it is raster generation.
 *
 * ## Why the attachment alone cannot answer it
 *
 * An image attachment plus "change the background" is an edit request the
 * image workspace cannot serve; the same attachment plus "what is in this
 * photo?" is an ordinary question chat answers well. The two carry identical
 * attachment descriptors. Deciding from the attachment would attach an
 * editing-limitation notice to every turn that merely asks about a picture.
 *
 * ## Why the input is normalised
 *
 * The server holds `TurnAttachmentDescriptor`s and the composer holds
 * attachments that have not been uploaded yet. Both adapt to
 * `ImageIntentInput` (lib/imageIntentInput.ts) before they get here, so this
 * module imports neither shape and the parity tests have something to compare.
 *
 * Filenames, sizes and upload ids are deliberately absent. Not because the
 * attachment policy forbids them -- `uploadId`, `name`, `mediaType` and `size`
 * are returned to the client by design
 * (docs/policy/user-attachment-persistence.md §4) -- but because a
 * classifier that reads filenames starts judging on `logo.png` instead of on
 * what the person wrote. Storage keys and raw bytes are absent for the other
 * reason: docs/policy/user-attachment-persistence.md §2
 * refuses them everywhere.
 *
 * Pure and synchronous: the composer calls it between keystrokes.
 */

/** The turn's dominant image intent. One value; each consumer narrows it. */
export const IMAGE_INTENT_CLASSES = [
  /** A picture, illustration, photo or scene to be generated from text. */
  "raster_generation",
  /** A chart, diagram or infographic whose value is its text. */
  "text_heavy_visual",
  /** Edit, extend or take an attached image as a reference. */
  "edit_or_reference",
  /** Read an attached image and answer about it. */
  "analysis",
  /** Text art was asked for by name; it is not a substitution. */
  "explicit_text_art",
  /** Nothing about images. */
  "none",
] as const;

export type ImageIntentClass = (typeof IMAGE_INTENT_CLASSES)[number];

export type ImageIntentAttachment = { kind: "image" | "other" };

export type ImageIntentInput = {
  text: string;
  attachments: readonly ImageIntentAttachment[];
};

/* ------------------------------------------------------------------------ */
/* Vocabulary                                                                */
/* ------------------------------------------------------------------------ */

// Korean verbs that ask for something to be produced pictorially. Matched as
// stems because Korean conjugates: "그려 줘", "그려줄래", "그려주세요".
const KO_DRAW_VERBS = [
  "그려",
  "그림으로",
  "그려서",
  "그려줘",
  "만들어",
  "생성해",
  "생성 해",
  "뽑아",
  "제작해",
];

/**
 * English producing verbs, matched as whole words in their base form.
 *
 * Base form only, and that is the rule doing the work: "what makes a good
 * illustration" is a question *about* illustrations, and a substring match on
 * "make" read it as a request for one. English asks for things in the
 * imperative -- "draw a cat", "can you make a poster" -- so an inflected verb
 * is nearly always describing rather than instructing.
 *
 * "picture" is deliberately absent here even though it can be a verb: it is
 * already a noun below, and counting it twice would let the noun satisfy its
 * own verb requirement.
 */
const EN_DRAW_VERB_PATTERN =
  /\b(?:draw|generate|create|make|render|paint|illustrate|design|sketch)\b/;

/**
 * Verbs whose meaning is already pictorial, and which therefore carry the
 * request without a noun.
 *
 * "draw a cat" names no noun this file lists, and it is as plainly an image
 * request as "draw a picture of a cat". Requiring a noun from a closed list
 * would answer every unlisted subject with silence -- and the subject of a
 * picture is the one part of the request that cannot be enumerated.
 *
 * Only the unambiguous ones. `make`, `create`, `generate` and `design` stay in
 * the pair rule above, because "make a summary" and "generate a report" are
 * not image requests. `render` is deliberately absent as well: in a product
 * whose users write about software, "render the component" is the commoner
 * reading.
 */
const KO_PICTORIAL_VERBS = ["그려", "그림으로"];
const EN_PICTORIAL_VERB_PATTERN = /\b(?:draw|paint|sketch|illustrate)\b/;

/**
 * Where those verbs are idiom rather than instruction.
 *
 * Checked before the verb counts, because "draw a conclusion" and "paint a
 * picture of what happened" are about reasoning and describing. A chip on
 * either is noise in the place a person is trying to type.
 */
const EN_PICTORIAL_FALSE_FRIENDS = [
  "draw a conclusion",
  "draw conclusions",
  "draw attention",
  "draw the line",
  "draw a line under",
  "draw up",
  "draw on ",
  "draw from",
  "drawing board",
  "paint a picture of what",
  "paints a picture",
];

// What the person wants to end up with. Split from the verbs because "make a
// summary" is not an image request and "draw a cat" is: the pair is the
// signal, not either half.
const KO_RASTER_NOUNS = [
  "그림",
  "이미지",
  "사진",
  "일러스트",
  "삽화",
  "포스터",
  "배경",
  "배경화면",
  "썸네일",
  "캐릭터",
  "로고",
  "아트",
  "장면",
  "풍경",
  "초상화",
];

const EN_RASTER_NOUNS = [
  "image",
  "picture",
  "photo",
  "photograph",
  "illustration",
  "artwork",
  "art",
  "poster",
  "wallpaper",
  "background",
  "thumbnail",
  "character",
  "logo",
  "scene",
  "landscape",
  "portrait",
  "drawing",
  "painting",
];

// Visuals whose worth is the text inside them. Held apart from the raster
// nouns because the destination question for these is still open -- see
// .github/audits/image-intent-auto-switch-2026-08-24.md §6, the L3 item.
// A text-to-image model is not obviously the right answer for a Korean
// infographic, so they must never reach the chip.
const KO_TEXT_HEAVY_NOUNS = [
  "인포그래픽",
  "도표",
  "도식",
  "다이어그램",
  "차트",
  "그래프",
  "순서도",
  "흐름도",
  "플로우차트",
  "조직도",
  "마인드맵",
  // Particle-bound, so a stray "표" inside another word is not a request for
  // one. Both forms, because "표로 만들어 줘" and "표를 그려 줘" are the same ask.
  "표로",
  "표를",
  "타임라인",
];

const EN_TEXT_HEAVY_NOUNS = [
  "infographic",
  "diagram",
  "chart",
  "graph",
  "flowchart",
  "flow chart",
  "org chart",
  "mind map",
  "mindmap",
  "timeline",
  "schematic",
  // "table" is deliberately absent. It is one of the commonest nouns in an
  // ordinary sentence -- "what can you draw from the table" is a question
  // about data -- and a request for a table is a request for a table, which
  // this chat answers directly rather than as a picture.
];

// Text art asked for by name. This is not the silent substitution the notice
// block exists to stop -- refusing it would refuse what was asked for.
const TEXT_ART_PHRASES = [
  "ascii",
  "아스키",
  "text art",
  "텍스트 아트",
  "텍스트아트",
  "문자 그림",
  "문자그림",
  "ansi art",
  "아트로 그려",
];

// Acting on an image that is already here.
const KO_EDIT_VERBS = [
  "바꿔",
  "바꾸어",
  "변경해",
  "지워",
  "삭제해",
  "제거해",
  "합성해",
  "합쳐",
  "보정해",
  "수정해",
  "편집해",
  "잘라",
  "크롭",
  "확대해",
  "지우고",
  "넣어",
  "추가해",
  "입혀",
  "따라 그려",
  "스타일로",
  "참고해서",
  "참조해서",
  "비슷하게",
];

const EN_EDIT_VERBS = [
  "edit",
  "change",
  "replace",
  "remove",
  "erase",
  "delete",
  "retouch",
  "restore",
  "upscale",
  "crop",
  "extend",
  "outpaint",
  "inpaint",
  "recolor",
  "recolour",
  "swap",
  "add to",
  "combine",
  "merge",
  "in the style of",
  "based on this",
  "use this as a reference",
  "like this one",
];

// Reading an attachment rather than acting on it.
const KO_ANALYSIS_VERBS = [
  "설명해",
  "알려",
  "분석해",
  "읽어",
  "요약해",
  "무엇",
  "뭐야",
  "뭔가요",
  "어디야",
  "누구",
  "찾아",
  "번역해",
  "인식해",
  "판단해",
  "평가해",
];

const EN_ANALYSIS_VERBS = [
  "describe",
  "explain",
  "analyse",
  "analyze",
  "what is",
  "what's",
  "who is",
  "where is",
  "read",
  "summarise",
  "summarize",
  "translate",
  "identify",
  "review",
  "tell me about",
];

/* ------------------------------------------------------------------------ */
/* Matching                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * The floor, borrowed from `suggestsWebSearchInComposer`.
 *
 * A verdict after two keystrokes is noise, and on this surface it also resizes
 * the composer. Below the floor everything is `none`.
 */
const MINIMUM_DRAFT_LENGTH = 4;

const normalize = (text: string) => text.trim().toLowerCase();

const containsAny = (haystack: string, needles: readonly string[]) =>
  needles.some((needle) => haystack.includes(needle));

/**
 * English matching is by whole word; Korean matching is by substring.
 *
 * The asymmetry is the languages, not a preference. Korean agglutinates --
 * "그림으로", "그림을", "그림도" are all the same noun plus a particle -- so a
 * substring is the only stem match available. English does not, and substrings
 * there are actively wrong: "graph" is inside "paragraph", "art" is inside
 * "quarter", and both produced confident nonsense before this existed.
 *
 * Built once per list rather than per call: the composer runs this between
 * keystrokes.
 */
const wordPatterns = new WeakMap<readonly string[], RegExp>();
const escapeForPattern = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const containsWord = (haystack: string, words: readonly string[]) => {
  let pattern = wordPatterns.get(words);
  if (!pattern) {
    pattern = new RegExp(`\\b(?:${words.map(escapeForPattern).join("|")})\\b`);
    wordPatterns.set(words, pattern);
  }
  return pattern.test(haystack);
};

/**
 * Whether a *phrase* asks for a visual, rather than whether a word appeared.
 *
 * The unit is deliberately the pair, not the word. "설명해 줘" is not an image
 * request and "그림으로 설명해 줘" is; a rule that read "설명" as a negative
 * signal would lose the second, and one that read "그림" alone as positive
 * would fire on "그림 같은 풍경을 글로 묘사해 줘". So a noun counts when a
 * producing verb is present, and the two Korean forms that carry the verb
 * inside the noun phrase ("그림으로", "이미지로") count on their own.
 */
const asksToProduce = (
  text: string,
  nouns: readonly string[]
): boolean => {
  const hasNoun = containsAny(text, nouns);
  if (!hasNoun) return false;
  const hasVerb =
    containsAny(text, KO_DRAW_VERBS) || EN_DRAW_VERB_PATTERN.test(text);
  if (hasVerb) return true;
  // "…로 만들어" without a verb we listed, e.g. "인포그래픽으로." The particle
  // carries the request in Korean; English needs the verb.
  // No trailing `\b`: word boundaries are ASCII-defined, so a Hangul syllable
  // followed by a space has none, and the anchor silently rejected every
  // Korean match it was meant to accept.
  return /(?:그림|이미지|사진|일러스트|인포그래픽|도식|도표|차트|다이어그램|그래프|순서도|타임라인)\s*으?로/.test(
    text
  );
};

/** The same pair rule, with English word matching for the noun. */
const asksToProduceEnglish = (
  text: string,
  nouns: readonly string[]
): boolean => containsWord(text, nouns) && EN_DRAW_VERB_PATTERN.test(text);

/**
 * A pictorial verb with no idiom around it -- enough on its own.
 *
 * Reached only after the text-heavy check, so "표를 그려 줘" and "draw a
 * flowchart" have already been classified by what they asked for rather than
 * by the verb.
 */
const asksToDrawSomething = (text: string): boolean => {
  if (EN_PICTORIAL_FALSE_FRIENDS.some((phrase) => text.includes(phrase))) {
    return false;
  }
  return (
    containsAny(text, KO_PICTORIAL_VERBS) || EN_PICTORIAL_VERB_PATTERN.test(text)
  );
};

/**
 * The turn's image intent.
 *
 * Order matters and is the contract:
 *
 *   1. explicit text art  -- asked for by name, so nothing below applies;
 *   2. attachment present -- edit and analysis are only possible with one, and
 *                            they are told apart by the verb, never by the
 *                            attachment;
 *   3. text-heavy visual  -- held ahead of raster because "infographic" also
 *                            matches the generic drawing verbs, and sending it
 *                            to a text-to-image workspace is the wrong answer;
 *   4. raster generation.
 */
export const classifyImageIntent = (input: ImageIntentInput): ImageIntentClass => {
  const text = normalize(input.text);
  if (text.length < MINIMUM_DRAFT_LENGTH) return "none";

  if (containsAny(text, TEXT_ART_PHRASES)) return "explicit_text_art";

  const hasImageAttachment = input.attachments.some(
    (attachment) => attachment.kind === "image"
  );

  if (hasImageAttachment) {
    const asksToEdit =
      containsAny(text, KO_EDIT_VERBS) || containsWord(text, EN_EDIT_VERBS);
    if (asksToEdit) return "edit_or_reference";
    const asksAbout =
      containsAny(text, KO_ANALYSIS_VERBS) ||
      containsWord(text, EN_ANALYSIS_VERBS);
    if (asksAbout) return "analysis";
    // An attachment with a producing request beside it is still asking for
    // something to be made *from* it -- a reference, which is equally out of
    // scope -- rather than a fresh text-to-image run.
    if (
      asksToProduce(text, KO_RASTER_NOUNS) ||
      asksToProduceEnglish(text, EN_RASTER_NOUNS)
    ) {
      return "edit_or_reference";
    }
    return "none";
  }

  if (
    asksToProduce(text, KO_TEXT_HEAVY_NOUNS) ||
    asksToProduceEnglish(text, EN_TEXT_HEAVY_NOUNS)
  ) {
    return "text_heavy_visual";
  }

  if (
    asksToProduce(text, KO_RASTER_NOUNS) ||
    asksToProduceEnglish(text, EN_RASTER_NOUNS) ||
    asksToDrawSomething(text)
  ) {
    return "raster_generation";
  }

  return "none";
};

/* ------------------------------------------------------------------------ */
/* Consumers                                                                 */
/* ------------------------------------------------------------------------ */

/** What the notice block's branch is called. Three values, and only three. */
export type L0ImageIntent = "none" | "edit_or_reference" | "text_heavy_visual";

/**
 * Which branch of the notice block this turn takes.
 *
 * Two of the six classes change what the block says, and for opposite reasons:
 *
 *   `edit_or_reference`   the turn is about a picture that is already here, so
 *                         the workspace and the file alternative are both
 *                         wrong and are replaced by the editing limitation;
 *   `text_heavy_visual`   a chart or infographic is a file this app can
 *                         actually produce, so the block stops *offering* one
 *                         and tells the model to make it.
 *
 * The rest -- raster, analysis, text art, none -- share the default branch,
 * because for them the block's paragraphs are chosen by what the *viewer* can
 * reach rather than by what they asked for.
 */
export const l0ImageIntent = (intentClass: ImageIntentClass): L0ImageIntent => {
  if (intentClass === "edit_or_reference") return "edit_or_reference";
  if (intentClass === "text_heavy_visual") return "text_heavy_visual";
  return "none";
};

/**
 * Which turns are offered a handoff to image generation.
 *
 * Both surfaces read this: the composer chip before sending, and the control
 * under a finished answer. One predicate, because a person who is offered the
 * workspace while typing and refused it after reading the answer would have
 * learned nothing except that the offer is arbitrary.
 *
 * ## Why text-heavy visuals are in it now
 *
 * They were excluded while the destination was an open product question
 * (.github/audits/image-intent-auto-switch-2026-08-24.md §6). It was settled
 * on 2026-08-25 in favour of offering it, on the evidence of what the
 * exclusion actually produced: the model, told to make a file and not to
 * mention the workspace, listed the workspace as option 4 of 4 and asked
 * which the user wanted. The user picked 4, and the model -- correctly, since
 * it cannot navigate -- said it had no way to get there.
 *
 * The exclusion also never reached the person. It removed the *control* and
 * left the *sentence*, which is the worst half: a destination named in prose
 * that only the app can walk to.
 *
 * A text-to-image model still renders Korean text poorly, and that is the
 * reason the SVG file remains what an infographic request produces first.
 * The handoff is offered beside it, not instead of it -- see
 * `lib/imageCapabilityPrompt.ts`.
 */
export const offersImageHandoffChip = (intentClass: ImageIntentClass): boolean =>
  intentClass === "raster_generation" || intentClass === "text_heavy_visual";

/**
 * Stable key for "have we already offered on this draft".
 *
 * Same shape as `draftSuggestionKey` in lib/webSearchSuggestion.ts, and for
 * the same reason: deterministic per trimmed draft, not cryptographic.
 */
export const imageIntentDraftKey = (draft: string): string => normalize(draft);

/**
 * How much a draft must move before the chip may be offered again.
 *
 * **An experimental constant, not a policy value**
 * (.github/audits/image-intent-auto-switch-2026-08-24.md §5.3). There is no
 * evidence behind 0.3; it is a starting point, and the measurements in
 * .github/audits/image-intent-auto-switch-2026-08-24.md §7
 * are what should move it. Named and exported so a change is a change to one
 * number with a test on it, rather than an edit inside a condition.
 */
export const IMAGE_INTENT_RESHOW_CHANGE_RATIO = 0.3;

/**
 * Whether a dismissed chip may come back for this draft.
 *
 * Two ways: the draft moved substantially, or it grew a raster signal it did
 * not have when it was dismissed. The caller still enforces "once per draft".
 */
export const allowsImageHandoffReshow = (input: {
  dismissedKey: string;
  currentKey: string;
  dismissedIntent: ImageIntentClass;
  currentIntent: ImageIntentClass;
}): boolean => {
  if (input.currentKey === input.dismissedKey) return false;
  if (
    input.currentIntent === "raster_generation" &&
    input.dismissedIntent !== "raster_generation"
  ) {
    return true;
  }
  const longest = Math.max(
    input.dismissedKey.length,
    input.currentKey.length,
    1
  );
  const moved = Math.abs(input.currentKey.length - input.dismissedKey.length);
  return moved / longest >= IMAGE_INTENT_RESHOW_CHANGE_RATIO;
};
