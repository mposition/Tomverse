import { estimatePromptTokens } from "@/lib/chatTokenEstimate";
import { IMAGE_PROMPT_MAX_TOKENS } from "@/lib/imageGenerationPricing";

/**
 * The meme tool: the image model stages a reaction shot without lettering, and
 * the product letters the caption, so the words are always exact and can be
 * changed without generating again.
 */
export function studioMemePrompt(options: { hasPhoto: boolean; situation: string; caption: string }) {
  // A long situation is shortened from its end until the brief fits the image prompt limit.
  let situation = options.situation.trim();
  const brief = () => [
    options.hasPhoto
      ? "Cast the person in the photo as the protagonist. Likeness comes first: keep this person's face shape and fullness, brows, eyes, nose, lips, hairline, hair and any glasses or facial hair, at their real age."
      : "Create one original reaction image with an everyday, relatable protagonist.",
    "Make a reaction meme photo: one freeze-frame, like a still from a sitcom or a variety show, that is funny before any caption is read. One protagonist fills the frame from the chest up, the face large in the upper two-thirds, with a single exaggerated but believable expression that delivers the punchline: smug triumph, deadpan stare, awkward denial, weary disbelief or the like.",
    "Tell the situation with at most two clear props or one background detail and keep everything else simple and uncluttered. No crowd, no collage, no glowing effects and no arbitrary spectacle.",
    "Square, edge to edge, candid snapshot lighting. Keep the bottom quarter visually calm with table, floor, clothing or soft background, because the caption is lettered there afterwards; never leave a blank band or a panel. No letters, words, signs with writing, logos, caption boxes or watermarks anywhere. The caption is context for the acting only.",
    JSON.stringify({ situation, captionContext: options.caption.trim() }),
  ].join(" ");
  while (situation.length > 40 && estimatePromptTokens(brief()) > IMAGE_PROMPT_MAX_TOKENS) {
    situation = situation.slice(0, Math.floor(situation.length * .9)).trimEnd();
  }
  return brief();
}

const graphemes = (text: string) => typeof Intl.Segmenter === "function"
  ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(part => part.segment)
  : Array.from(text);

/**
 * Breaks a caption into one to three lines of similar width, at spaces where it
 * has them, and reports how far the type must shrink for the widest line to fit.
 * The fewest lines that keep the type at three quarters of its size or more win.
 */
export function studioMemeCaptionLines(text: string, width: (line: string) => number, maxWidth: number) {
  const caption = text.trim().replace(/\s+/g, " ");
  // Scripts written without spaces may break between any two characters; a single Latin word may not.
  const unspaced = !caption.includes(" ") && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(caption);
  const words = unspaced ? graphemes(caption) : caption.split(" ");
  const glue = unspaced ? "" : " ";
  let best = { lines: [caption], scale: Math.min(1, maxWidth / Math.max(1, width(caption))) };
  for (let count = 2; count <= 3 && best.scale < .75 && words.length >= count; count++) {
    // Fill each line up to an even share of what is left, so no line is left with one short word.
    const lines: string[] = [];
    let rest = words;
    for (let left = count; left > 0; left--) {
      const share = width(rest.join(glue)) / left;
      let take = 1;
      while (left > 1 && take < rest.length - (left - 1) &&
        Math.abs(width(rest.slice(0, take + 1).join(glue)) - share) < Math.abs(width(rest.slice(0, take).join(glue)) - share)) take++;
      // A break just after a sentence mark reads better than a slightly more even one a word later.
      const marked = (count: number) => /[.!?,…。！？、]$/.test(rest[count - 1]);
      if (left > 1 && take > 1 && !marked(take) && marked(take - 1) &&
        Math.abs(width(rest.slice(0, take - 1).join(glue)) - share) <= share * .25) take--;
      if (left === 1) take = rest.length;
      lines.push(rest.slice(0, take).join(glue));
      rest = rest.slice(take);
    }
    const scale = Math.min(1, maxWidth / Math.max(1, ...lines.map(width)));
    if (scale > best.scale) best = { lines, scale };
  }
  return best;
}
