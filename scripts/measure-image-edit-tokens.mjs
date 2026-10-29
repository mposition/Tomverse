// Measures what OpenAI bills as image input for a gpt-image-2 edit of a photo
// the size the executor sends (fit inside 1024px), so the edit budget in
// lib/imageGenerationPricing.ts (gpt-image-2's edit pricing) can be
// recorded from evidence rather than estimated.
//
// PAID: three low-quality edits, roughly US$0.30 at the worst case. Runs only
// with --confirm-paid, and only with the owner's approval of that spend.
//
//   node scripts/measure-image-edit-tokens.mjs --confirm-paid
//
// Needs OPENAI_IMAGE_API_KEY (or OPENAI_API_KEY) in the environment. Prints
// the reported usage per shape and the maximum image-input tokens.

import sharp from "sharp";

if (!process.argv.includes("--confirm-paid")) {
  console.error("Refusing to run: this makes paid OpenAI edit calls. Pass --confirm-paid.");
  process.exit(2);
}
const apiKey = process.env.OPENAI_IMAGE_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENAI_IMAGE_API_KEY or OPENAI_API_KEY is required.");
  process.exit(2);
}

// The three shapes the executor can send after fitting inside 1024px. Noise,
// not a flat fill, so the encoder sees photo-like detail.
const shapes = [
  { name: "square", width: 1024, height: 1024, size: "1024x1024" },
  { name: "landscape", width: 1024, height: 768, size: "1536x1024" },
  { name: "portrait", width: 768, height: 1024, size: "1024x1536" },
];

let max = 0;
for (const shape of shapes) {
  const noise = Buffer.alloc(shape.width * shape.height * 3);
  for (let index = 0; index < noise.length; index += 1) noise[index] = Math.floor(Math.random() * 256);
  const png = await sharp(noise, { raw: { width: shape.width, height: shape.height, channels: 3 } })
    .png()
    .toBuffer();
  const form = new FormData();
  form.set("model", "gpt-image-2");
  form.set("prompt", "Make the image slightly brighter. Keep everything else the same.");
  form.set("size", shape.size);
  form.set("quality", "low");
  form.set("output_format", "png");
  form.set("n", "1");
  form.set("image", new Blob([new Uint8Array(png)], { type: "image/png" }), "image.png");
  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(`${shape.name}: HTTP ${response.status}`, JSON.stringify(body?.error ?? body));
    process.exitCode = 1;
    continue;
  }
  const usage = body?.usage ?? null;
  const imageTokens = usage?.input_tokens_details?.image_tokens ?? null;
  if (typeof imageTokens === "number") max = Math.max(max, imageTokens);
  console.log(JSON.stringify({ shape: shape.name, input: `${shape.width}x${shape.height}`, usage }));
}
console.log(JSON.stringify({ measuredMaxImageInputTokens: max, measuredAt: new Date().toISOString().slice(0, 10) }));
