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
  [["사랑해", "Love you!", "我爱你", "我愛你"], "Tender grin peeking over a huge red felt heart hugged tightly; heart fills the lower half."],
  [["대박!", "Wow!"], "Jaw drops, both hands fly open, coral reaction burst."],
  [["괜찮아", "No worries"], "Soft closed-eye smile, cheek and arms pressing into a huge teal cushion."],
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

function stickerAction(caption: string, compact = false) {
  return stickerActionByCaption.get(caption.trim()) ??
    (compact ? "" : "Act out the meaning of ") + JSON.stringify(caption);
}

export function studioStickerPrompt(style: StudioStickerFaceStyle, captions: readonly string[]) {
  const identity = style === "real"
    ? "Live-action comedy sticker art, photographed like an energetic editorial campaign. Keep the reference face shape, eye shape and spacing, nose, complexion, hair and eyewear recognizable from new angles. Render lifelike skin and materials. Keep wardrobe and lighting consistent while directing the actor, camera distance and props for each gag."
    : "Make expressive chibi character cutouts of the reference person. Preserve their distinctive face shape, hair, skin tone and eyewear. Draw coherent shapes, selective ink and soft shading, with recognizable features and lively expressions.";
  const art = "Capture the peak reaction. Alternate a lens-filling hand, tight double take, waist-up prop gag, and airborne full-body pose. Let the hero prop rival the torso and show its weight. Add a few saturated gold, coral or cyan motion marks that follow the gesture.";
  const lettering = "Compose each scene for a large hand-painted marker caption with thick rounded strokes, a bouncy baseline, and deep berry, teal or orange ink. Leave a short open shape alongside the action or on a broad solid prop. Vary the side, angle and height between cells. Keep the eyes, gesture and important prop details clear.";
  const output = "Isolate the artwork on solid #00FF00. Keep that green out of the art. The app places captions; leave the lettering areas empty. Draw no letters, logos, caption panels, grid lines, frames or cast shadows.";
  if (captions.length === 1) {
    return ["Make one centered chat sticker. Stage it diagonally and fill the image, with a narrow green margin and all cues visible.", identity, art, lettering, output, "Action: " + stickerAction(captions[0])].join("\n");
  }

  const { columns, rows } = studioStickerLayout(captions.length);
  const cues = (compact = false) => Array.from({ length: rows }, (_, row) => {
    const actions = captions.slice(row * columns, (row + 1) * columns).map(caption => stickerAction(caption, compact));
    const slots = [...actions, ...Array<string>(columns - actions.length).fill("[empty]")];
    return "Row " + (row + 1) + ": " + slots.join(" | ");
  });
  const grid = "Make exactly " + captions.length + " cutouts in a fixed " + columns + "-column by " + rows + "-row grid.";
  const prompt = [
    grid + " Each cell is the same size.",
    "One large, standalone composition per action in order. Let its longest axis nearly fill the cell. Give each cell a slim green margin on all four sides, including the sheet perimeter. Keep silhouettes, props and marks within those margins. Empty cells stay green.",
    identity,
    art,
    lettering,
    output,
    "Actions in reading order:",
    ...cues(),
  ].join("\n");
  if (estimatePromptTokens(prompt) <= IMAGE_PROMPT_MAX_TOKENS) return prompt;

  const face = style === "real" ? "Live-action comedy sticker. Preserve the reference person's likeness and photographic skin." : "Draw a recognizable character from the reference.";
  return [
    grid, face,
    "Stage each cue at peak reaction with tight framing or full-body motion and huge props. Leave a close shape for large rounded hand-lettering. Use narrow #00FF00 seams and green empty cells. Draw no text.",
    ...cues(true),
  ].join("\n");
}
