import { studioStickerLayout } from "./studioTools";

export type StudioStickerFaceStyle = "real" | "character";

export function studioStickerPrompt(style: StudioStickerFaceStyle, captions: readonly string[]) {
  const identity = style === "real"
    ? "Edit the attached portrait. Each face must look like another photo of this exact person. Preserve face shape, eye shape and spacing, eyebrows, nose, lips, jawline, hairline, skin tone, age and distinguishing features. No face reshaping, beautification or generic replacement face. Keep the face photographic, even if the body or props are illustrated."
    : "Draw the exact person in the attached portrait as a cohesive chibi character. Keep their distinctive face shape, hair, eyes, eyebrows, skin tone and glasses if present. Use clean lines, rounded proportions and soft shading.";
  const direction = "Vary expression, pose and props to convey each emotion while keeping identity and scale consistent. Use a perfectly flat #00FF00 background and keep that green out of the artwork. Render illustrations only: no text, letters, numbers, logos, borders or labels. The quoted captions are acting cues only.";
  if (captions.length === 1) {
    return `${identity} Make one centered chat sticker with plenty of clear green space around it. ${direction}\nCue: ${JSON.stringify(captions[0])}`;
  }

  const { columns, rows } = studioStickerLayout(captions.length);
  const cues = Array.from({ length: rows }, (_, row) => {
    const line = captions.slice(row * columns, (row + 1) * columns);
    const slots = [...line.map(caption => JSON.stringify(caption)), ...Array<string>(columns - line.length).fill("[empty]")];
    return `Row ${row + 1}: ${slots.join(" | ")}`;
  });
  return [
    `Make exactly ${captions.length} separate chat stickers in a fixed ${columns}-column by ${rows}-row grid spanning the entire canvas. Include every specified row. One sticker per occupied cell, in the exact order listed below, and leave [empty] cells pure green.`,
    "Center the subject, including all props and effects, within the middle 74% of each cell. Keep uninterrupted green gutters along all cell edges. Do not merge, skip or reorder cells.",
    identity,
    direction,
    "Rows from top to bottom, cells from left to right:",
    ...cues,
  ].join("\n");
}
