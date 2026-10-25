import sharp from "sharp";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Generate platform sizes from the unchanged, existing Tomverse brand asset.
const source = fileURLToPath(new URL("../../public/tomverse-logo.png", import.meta.url));
const resources = new URL("./android/app/src/main/res/", import.meta.url);
const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(sizes)) {
  for (const name of ["ic_launcher", "ic_launcher_round"]) {
    await sharp(source).resize(size, size).png().toFile(fileURLToPath(new URL(`mipmap-${density}/${name}.png`, resources)));
  }
  const canvas = Math.round(size * 108 / 48);
  const logo = await sharp(source).resize(Math.round(canvas * 0.60)).png().toBuffer();
  await sharp({ create: { width: canvas, height: canvas, channels: 4, background: "#ffffff" } })
    .composite([{ input: logo, gravity: "centre" }]).png()
    .toFile(fileURLToPath(new URL(`mipmap-${density}/ic_launcher_foreground.png`, resources)));
}
const splash = await sharp(source).resize(160).png().toBuffer();
for (const directory of await readdir(resources, { withFileTypes: true })) {
  if (!directory.isDirectory() || !directory.name.startsWith("drawable")) continue;
  const files = await readdir(new URL(directory.name + "/", resources));
  if (!files.includes("splash.png")) continue;
  await sharp({ create: { width: 640, height: 640, channels: 4, background: "#f7f9fd" } })
    .composite([{ input: splash, gravity: "centre" }]).png()
    .toFile(fileURLToPath(new URL(directory.name + "/splash.png", resources)));
}
await sharp(source).resize(1024, 1024).removeAlpha().png()
  .toFile(fileURLToPath(new URL("./ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", import.meta.url)));
for (const suffix of ["", "-1", "-2"]) {
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: "#f7f9fd" } })
    .composite([{ input: splash, gravity: "centre" }]).png()
    .toFile(fileURLToPath(new URL(`./ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732${suffix}.png`, import.meta.url)));
}
console.log("Generated native icons and splash assets from public/tomverse-logo.png.");
