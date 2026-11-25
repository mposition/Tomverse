import { estimatePromptTokens } from "@/lib/chatTokenEstimate";
import { IMAGE_PROMPT_MAX_TOKENS } from "@/lib/imageGenerationPricing";
import { studioCopy } from "@/locales/studio";
import { STUDIO_STICKER_KEYS, studioStickerLayout } from "./studioTools";

export type StudioStickerFaceStyle = "real" | "character";

const DEFAULT_STICKER_ACTIONS = {
  stickerDefault01: "Winking close-up, foreshortened thumbs-up filling the foreground.",
  stickerDefault02: "Limp over a chair back, cheek squashed on the rail, both arms dangling.",
  stickerDefault03: "Crescent eyes peek over a bouquet as wide as the shoulders.",
  stickerDefault04: "Head tilted back mid-cheer, oversized red megaphone aimed diagonally out.",
  stickerDefault05: "Head thrown back in laughter, one hand on the belly.",
  stickerDefault06: "Knowing nod and fingertip tapping the temple.",
  stickerDefault07: "Huge palm foreshortened toward the lens, wide-eyed face peeking beside it.",
  stickerDefault08: "Full-body diagonal sprint, airborne legs and a backpack swinging upward.",
  stickerDefault09: "Deep comic bow with the whole bent body in view, apologetic eyes glancing up.",
  stickerDefault10: "Profile mid-blow, party horn unfurls, free hand reaches into bright confetti.",
  stickerDefault11: "Peeking warily from inside an oversized quilt.",
  stickerDefault12: "Low-angle lunge, open mouth reaching for an improbably tall burger in both hands.",
  stickerDefault13: "Sleepy eyes and hunched shoulders, both hands wrapped around a giant steaming mug.",
  stickerDefault14: "Raised eyebrow, leaning close for a doubtful double take.",
  stickerDefault15: "Calm smile with one open reassuring hand.",
  stickerDefault16: "Full-body curl with tucked knees around a huge pillow, relaxed sleeping face.",
  stickerDefault17: "Extreme close-up, eyes wide, jaw dropped and palms on cheeks.",
  stickerDefault18: "Broad goofy grin, playful finger guns foreshortened toward the lens.",
  stickerDefault19: "Arriving at a doorstep, holding up keys in relief.",
  stickerDefault20: "Over-the-shoulder wave, body already mid-stride.",
} satisfies Record<(typeof STUDIO_STICKER_KEYS)[number], string>;

const EXTRA_STICKER_ACTIONS = [
  [["사랑해", "Love you!", "我爱你", "我愛你"], "Tender grin peeking over a huge red felt heart hugged tightly; paint the caption in cream across the heart."],
  [["대박!", "Wow!"], "Jaw drops, both hands fly open, coral reaction burst."],
  [["괜찮아", "No worries"], "Cheek and arms pressing into a huge teal cushion; sweep the cream caption across its fabric."],
  [["보고 싶어", "Miss you"], "Longing gaze reaching toward a small photo frame held close."],
  [["힘내!"], DEFAULT_STICKER_ACTIONS.stickerDefault04],
  [["피곤해"], DEFAULT_STICKER_ACTIONS.stickerDefault02],
  [["잠깐!"], DEFAULT_STICKER_ACTIONS.stickerDefault07],
  [["내일봐"], DEFAULT_STICKER_ACTIONS.stickerDefault20],
  [["기대돼", "Can't wait"], "Excited hands clasped, leaning toward a ribbon-tied present."],
  [["최고야"], "Holding up a gigantic gold trophy, triumphant smile."],
  [["안녕!"], "Warm forward wave with smiling crescent eyes."],
] as const;

const stickerActionByCaption = new Map<string, string>();

for (const copy of Object.values(studioCopy)) {
  for (const key of STUDIO_STICKER_KEYS) stickerActionByCaption.set(copy[key], DEFAULT_STICKER_ACTIONS[key]);
}
for (const [captions, action] of EXTRA_STICKER_ACTIONS) {
  for (const caption of captions) stickerActionByCaption.set(caption, action);
}

export function studioStickerBrief(style: StudioStickerFaceStyle, captions: readonly string[]) {
  const { columns, rows } = studioStickerLayout(captions.length);
  const layout = captions.length === 1 ? "Make one finished chat sticker."
    : `Make exactly ${captions.length} finished stickers in a regular ${columns}-column by ${rows}-row grid, in reading order. Leave unused trailing cells blank.`;
  const identity = style === "real"
    ? "Photograph the same actor as the left portrait: preserve the face shape, eyes, hair, complexion and eyewear. Keep lifelike skin, fabric and consistent wardrobe. Direct peak comedy reactions, mixing extreme close-ups, foreshortened gestures, huge tactile props and full-body motion."
    : "Draw a compact 2D chibi character based on the left portrait: a large rounded head, tiny body, simplified expressive eyes, bold curved ink contours and two-tone cel shading. Translate the person's distinctive brows, eye color, hair silhouette and accessories into a consistent character design. Only draw a mustache or beard if distinct facial hair is clearly visible in the portrait. Keep soft upper-lip shadow as skin tone, without dark strokes. Vary the silhouette and acting with each caption. Exactly one depiction of the person per sticker.";
  const lettering = "Use the right-side lettering specimens as your art direction: match the thick silhouette of each stroke, rounded chisel tips, lively tilt and open counters. Hand-letter each requested caption exactly once in its own script, preserving spelling, spaces and punctuation. Only the requested words may appear. For a short caption, draw the letters roughly a quarter of the cell height; the strokes should read at chat size. Compose type and action together. Change its position from cell to cell: arch above a pillow, tuck it beside a hand or wrap light cream letters across a large dark prop as in the red fabric specimen. Set free-standing words in deep plum, petrol teal or burnt orange, with an occasional gesture-led underline. Avoid stock fonts, generic corner labels, boxes and thick outlines.";
  const finish = "Use a flat warm ivory (#FFF6E9) sheet, including every cell edge. Fill each cell closely with an independent composition. Keep the entire caption, figure and accent marks inside a thin clear gutter. No grid lines or labels.";
  const intro = [layout, identity, lettering, finish].join("\n");
  const words = captions.map(caption => caption.trim());
  const cues = words.map(word => {
    const action = stickerActionByCaption.get(word);
    return JSON.stringify(word) + (action ? " — " + action : "");
  });
  const rowList = (entries: string[]) => Array.from({ length: rows }, (_, i) =>
    `Row ${i + 1}: ${entries.slice(i * columns, (i + 1) * columns).join(" | ")}`).join("\n");
  const full = intro + "\nAct out and letter each quoted caption:\n" + rowList(cues);
  if (estimatePromptTokens(full) <= IMAGE_PROMPT_MAX_TOKENS) return { prompt: full };
  const compact = intro + "\nAct out and letter each caption:\n" + rowList(words.map(word => JSON.stringify(word)));
  if (estimatePromptTokens(compact) <= IMAGE_PROMPT_MAX_TOKENS) return { prompt: compact };
  // The spelling key travels in the same reference image when the exact strings exceed the prompt budget.
  return { prompt: intro + "\nBelow the portrait is a numbered spelling key. Copy each caption's text into its corresponding sticker. Omit the numbers and act out each phrase.", spellingKey: words };
}
