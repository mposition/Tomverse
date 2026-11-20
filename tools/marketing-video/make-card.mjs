// Renders one 4:5 image card (1080x1350) that the job designed and wrote, and
// writes the asset file the submission needs:
//   node make-card.mjs <spec.json> <out-dir>
//
// Owner 2026-11-07: the job researches the market's ads and designs each card
// itself, words included, in the style the owner approved (examples/), and a
// person sees every card in Admin before anything is posted. So the words are
// the job's; what this file keeps is what the job cannot be trusted to keep.
//
// spec.json: {"id", "locale", "layout": "<HTML fragment, relative to the
// spec>", "alt": "<alt text>", "pack"?: "job/sources/<id>/pack.json"}. The
// fragment is a <style> block and the card's elements. Pictures are named as
// `capture:<name>` (a real screen capture from the pack) or `library:<name>`
// (library/library.json: the logo, model marks, photos), in an img src or a
// CSS url(), and are nothing else.
//
// It refuses the card when:
//  - a picture is not a capture or a library entry, anything else is fetched,
//    or the layout carries script, frames, form fields or CSS-generated text;
//  - a colour drawn is not a brand colour (pictures themselves excepted);
//  - a line lies outside the card or is clipped by its box;
//  - an AI-made library photo is used without the locale's AI line visibly on
//    the card, or together with a product capture (an AI asset may not show
//    the product);
//  - a versioned model name is not one features.json lists;
//  - the card looks like a card of an earlier day (a difference hash of the
//    picture, so new words on an old look fail).
// Every word the card shows goes into the transcript the Guard judges at
// submission, with the words inside the captures it used.
//
// The Higgsfield image path (owner 2026-11-08, run-higgsfield.mjs) adds
// `generated:<file>`: a picture an image model made today, taken only from
// <out-dir>/generated/. It is an AI photo like the library's (the locale's AI
// line, never beside a capture, provenance ai_generated). Its words are in the
// picture, not the layout, so such a spec carries `texts`, the approved words a
// second review read in the picture, and they go into the transcript. The
// address the band sets ("tomverse.app") is not judged: the Guard refuses any
// address (hygiene url_like), and that one is ours, fixed by the band code. The
// transcript and alt must pass the Guard's hygiene check here before submission.
//
// Exit codes: 0 written, 2 usage, 1 anything else.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";
import { featuresFile } from "./features-source.mjs";

const [specPath, outDir] = process.argv.slice(2);
if (!specPath || !outDir) {
  console.error("usage: node make-card.mjs <spec.json> <out-dir>");
  process.exit(2);
}

/** The channels a card may go to, per locale: the accounts that post in it (owner 2026-11-03, 2026-11-07). */
const CARD_CHANNELS = {
  en: ["facebook", "instagram", "linkedin", "x"],
  ko: ["facebook", "instagram", "threads"],
  "zh-Hant": ["facebook", "instagram", "threads"],
  "zh-Hans": ["rednote"],
};
/**
 * The channels a card on a generated picture goes to (design guide 13 of the
 * owner's 2026-11-08 instruction, docs/policy/marketing-automation.md §7.6).
 */
const GENERATED_CHANNELS = {
  en: ["facebook", "instagram", "linkedin", "x"],
  ko: ["instagram", "linkedin"],
  "zh-Hant": ["facebook", "instagram", "threads"],
  "zh-Hans": ["rednote"],
};
/** The address the band of a generated card sets; not the Guard's to judge (see above). */
const BAND_ADDRESS = "tomverse.app";
const GENERATED_NAME = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:png|jpe?g|webp)$/u;
/** The line a card with an AI-made photo shows, per locale. */
const AI_LINE = {
  en: "Photo: AI-generated",
  ko: "사진: AI 생성",
  "zh-Hant": "照片：AI 生成",
  "zh-Hans": "照片：AI 生成",
};
/** #ffffff #18181b #155dfb #eff6ff #f7f8fa #e4e4e7, as the browser reports them. */
const BRAND_RGB = ["255,255,255", "24,24,27", "21,93,251", "239,246,255", "247,248,250", "228,228,231"];
/**
 * How many of 256 hash bits must differ from every earlier day's card. Measured
 * 2026-11-07: the retired layout with only its words changed differed by 32;
 * four cards of different composition differed from it and each other by 92-144.
 */
const MIN_HASH_DISTANCE = 64;
const LOOKBACK_DAYS = 30;
const AI_PROVENANCES = ["ai_generated", "ai_modified"];
/** A model family followed, within a few words, by a version number. */
const MODEL_MENTION = /\b(?:GPT|Claude|Gemini|Grok|Llama|Mistral|Qwen|DeepSeek|Kimi|Nano Banana)\b[^,.;:!?\n]{0,20}?\d/gu;

const fail = (message) => {
  console.error(JSON.stringify({ step: "make-card", error: message }));
  process.exit(1);
};

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const locale = spec.locale;
if (!CARD_CHANNELS[locale]) fail(`no card channels for locale ${locale}`);
if (!/^media-[a-z0-9][a-z0-9-]{0,99}$/u.test(spec.id ?? "")) fail("spec.id is not a media asset id");
if (typeof spec.alt !== "string" || spec.alt.trim().length < 20) fail("spec.alt must describe the card");

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const libraryDir = path.join(toolDir, "library");
const library = JSON.parse(readFileSync(path.join(libraryDir, "library.json"), "utf8"));
const KNOWN_MODELS = JSON.parse(readFileSync(featuresFile(toolDir), "utf8")).features.flatMap((feature) => feature.models ?? []);

// The pack's captures, if the card uses a pack: `captures` ({name: {file,
// text}}), or the first packs' fixed five pictures.
let captures = {};
let packDir = null;
// A card that shows a pack's captures rests on the same claims as the approved
// short they came from, as cards did before (2026-11-04).
let packClaimIds = [];
if (spec.pack) {
  const packPath = path.resolve(spec.pack);
  const pack = JSON.parse(readFileSync(packPath, "utf8"));
  packDir = path.dirname(packPath);
  const sourceAsset = path.join(packDir, pack.videoAsset ?? "");
  if (!pack.videoAsset || !existsSync(sourceAsset)) fail("the pack names no source asset file to take its claims from");
  packClaimIds = [...(JSON.parse(readFileSync(sourceAsset, "utf8")).asset?.claimIds ?? [])];
  captures =
    pack.captures ??
    Object.fromEntries(
      [
        ["left", pack.captureText?.[0]],
        ["center", pack.captureText?.[1]],
        ["right", pack.captureText?.[2]],
        ["summary", pack.summaryText],
        ["logo", ""],
      ].map(([name, text]) => [name, { file: pack.images?.[name], text: text ?? "" }]),
    );
}
const generatedDir = path.resolve(outDir, "generated");
const pictureFile = (kind, name) => {
  if (kind === "capture") return captures[name] && packDir ? path.join(packDir, captures[name].file) : null;
  if (kind === "generated") {
    // Only a plain file name, inside today's generated/ folder.
    if (!GENERATED_NAME.test(name)) return null;
    const file = path.resolve(generatedDir, name);
    return path.dirname(file) === generatedDir ? file : null;
  }
  return library[name] ? path.join(libraryDir, library[name].file) : null;
};

const layoutPath = path.resolve(path.dirname(path.resolve(specPath)), spec.layout ?? "");
if (!spec.layout || !existsSync(layoutPath)) fail("spec.layout names no layout file");
const layout = readFileSync(layoutPath, "utf8");
if (/<\s*(script|iframe|object|embed|link|meta|base|frame|input|textarea|select|option|button|video|audio|canvas|use|image|foreignobject)\b|\son[a-z]+\s*=|javascript:|@import|<\s*svg[^>]*\shref|xlink:href/iu.test(layout)) {
  fail("the layout may hold only HTML, CSS and capture: or library: pictures");
}
const named = [...layout.matchAll(/(?:src\s*=\s*["']|url\(\s*["']?)([^"')\s]+)/giu)].map((match) => match[1]);
const PICTURE_REF = /^(capture|library|generated):([a-z0-9][a-z0-9.-]*)$/u;
const unknown = named.filter((ref) => {
  const m = PICTURE_REF.exec(ref);
  return !m || !pictureFile(m[1], m[2]) || !existsSync(pictureFile(m[1], m[2]));
});
if (unknown.length > 0) fail(`the layout names pictures that are not captures or library entries (or today's generated pictures):${JSON.stringify(unknown)}`);
const used = [...new Set(named)].map((ref) => [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)]);
const usedCaptures = used.filter(([kind]) => kind === "capture").map(([, name]) => name);
const usedGenerated = used.filter(([kind]) => kind === "generated");
const usedAi = used.filter(([kind, name]) => kind === "generated" || (kind === "library" && AI_PROVENANCES.includes(library[name].provenance)));
if (usedAi.length > 0 && usedCaptures.length > 0) {
  fail("an AI-made photo and a product capture may not share a card (an AI asset may not depict the product)");
}
const generated = usedGenerated.length > 0;
const pictureTexts = generated ? spec.texts : [];
if (generated && (!Array.isArray(pictureTexts) || pictureTexts.length === 0 || !pictureTexts.every((text) => typeof text === "string" && text.trim()))) {
  fail("a card on a generated picture lists the words in the picture as spec.texts");
}
const body = layout.replace(/(capture|library|generated):([a-z0-9][a-z0-9.-]*)/gu, (whole, kind, name) => {
  const file = pictureFile(kind, name);
  return file ? pathToFileURL(file).href : whole;
});

const fonts =
  locale === "zh-Hant"
    ? "'Geist', 'Noto Sans TC', sans-serif"
    : locale === "zh-Hans"
      ? "'Geist', 'Noto Sans SC', sans-serif"
      : "'Geist', 'Noto Sans KR', sans-serif";
const html = `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&family=Noto+Sans+KR:wght@400;500;700;900&family=Noto+Sans+TC:wght@400;500;700;900&family=Noto+Sans+SC:wght@400;500;700;900&family=Noto+Serif+KR:wght@500;700&family=Noto+Serif+TC:wght@500;700&family=Noto+Serif+SC:wght@500;700&display=block">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1080px; height: 1350px; overflow: hidden; }
  body { position: relative; font-family: ${fonts}; color: #18181b; background: #ffffff; -webkit-font-smoothing: antialiased; }
</style></head><body>
${body}
</body></html>`;

mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, `${spec.id}.html`);
writeFileSync(htmlPath, html);
const pngPath = path.join(outDir, `${spec.id}.png`);

/** The picture's 256-bit difference hash, as a 0/1 string (16 rows of 16 neighbour comparisons). */
async function differenceHash(page, file) {
  const data = readFileSync(file).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = Object.assign(document.createElement("canvas"), { width: 17, height: 16 });
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, 17, 16);
    const px = ctx.getImageData(0, 0, 17, 16).data;
    const grey = (x, y) => { const i = (y * 17 + x) * 4; return px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114; };
    let bits = "";
    for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) bits += grey(x, y) > grey(x + 1, y) ? "1" : "0";
    return bits;
  }, data);
}

/** Cards that earlier days made (job/<yyyymmdd>/media-*-card*.png within the lookback, never today's) and the examples. */
function earlierCards(today) {
  const jobDir = path.dirname(path.resolve(outDir));
  const cutoff = Number(new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10).replaceAll("-", ""));
  const found = [];
  for (const day of existsSync(jobDir) ? readdirSync(jobDir) : []) {
    if (!/^\d{8}$/u.test(day) || day === today || Number(day) < cutoff) continue;
    const dir = path.join(jobDir, day);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) if (/^media-.*-card(-\d+)?\.png$/u.test(file)) found.push(path.join(dir, file));
  }
  // The approved examples are style, not cards to copy.
  const examples = path.join(toolDir, "examples");
  for (const file of existsSync(examples) ? readdirSync(examples) : []) if (file.endsWith(".png")) found.push(path.join(examples, file));
  return found;
}

let cardLines = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
  const fetched = [];
  const allowedUrls = new Set(used.map(([kind, name]) => pathToFileURL(pictureFile(kind, name)).href));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    const ok =
      url === pathToFileURL(htmlPath).href ||
      allowedUrls.has(url) ||
      url.startsWith("https://fonts.googleapis.com/") ||
      url.startsWith("https://fonts.gstatic.com/");
    if (!ok) fetched.push(url);
    return ok ? route.continue() : route.abort();
  });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle", timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  if (fetched.length > 0) fail(`the layout fetched something else: ${JSON.stringify(fetched)}`);

  const found = await page.evaluate(([brand, aiLine]) => {
    const texts = [];
    const cut = [];
    const generated = [];
    const colours = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim() || node.parentElement.closest("style")) continue;
      const style = getComputedStyle(node.parentElement);
      if (style.visibility === "hidden" || style.display === "none") continue;
      texts.push(node.textContent);
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width === 0) continue;
        if (rect.left < -1 || rect.top < -1 || rect.right > 1081 || rect.bottom > 1351) cut.push(node.textContent);
      }
      const owner = node.parentElement;
      if (owner.scrollWidth > owner.clientWidth + 2 && getComputedStyle(owner).overflowX !== "visible") cut.push(node.textContent);
    }
    for (const el of [document.documentElement, ...document.querySelectorAll("body, body *")]) {
      for (const pseudo of ["::before", "::after", "::marker"]) {
        const content = getComputedStyle(el, pseudo).content;
        if (content && content !== "none" && content !== "normal" && content !== '""') generated.push(content);
      }
      const style = getComputedStyle(el);
      if (style.display === "list-item") generated.push("list-item");
      // The root's own text colour is the browser's black and draws nothing; its background does.
      const props = el === document.documentElement ? ["backgroundColor", "backgroundImage"] : ["color", "backgroundColor", "backgroundImage", "boxShadow", "textShadow", "filter"];
      if (el instanceof SVGElement) props.push("fill", "stroke");
      for (const side of ["Top", "Right", "Bottom", "Left"]) if (parseFloat(style[`border${side}Width`]) > 0) props.push(`border${side}Color`);
      if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) props.push("outlineColor");
      for (const prop of props) {
        for (const m of String(style[prop]).matchAll(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/gu)) {
          if (m[4] !== undefined && Number(m[4]) === 0) continue;
          const rgb = `${m[1]},${m[2]},${m[3]}`;
          if (!brand.includes(rgb)) colours.add(`${rgb} ${el.tagName} ${prop}`);
        }
        if (/\b(?:hsla?|lab|lch|oklab|oklch|color)\(/u.test(String(style[prop]))) colours.add(String(style[prop]));
      }
    }
    // What a reader reads as one phrase: the text of the nearest box that is
    // not inline, so "GPT <span>7</span>" is read as "GPT 7".
    const phrases = new Map();
    const smallest = new Map();
    const phraseWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (phraseWalker.nextNode()) {
      const node = phraseWalker.currentNode;
      // Spaces between inline pieces are kept: "<b>the</b> <b>only</b>" reads
      // "the only", not "theonly".
      if (node.parentElement.closest("style")) continue;
      let box = node.parentElement;
      while (box !== document.body && getComputedStyle(box).display === "inline") box = box.parentElement;
      phrases.set(box, `${phrases.get(box) ?? ""}${node.textContent}`);
      const size = parseFloat(getComputedStyle(node.parentElement).fontSize);
      smallest.set(box, Math.min(smallest.get(box) ?? size, size));
    }
    // Where the AI line sits, for the pixel check below: the box whose text
    // is exactly the line, every piece of it at least 14 px, inside the card.
    let aiBox = null;
    if (aiLine !== null) {
      for (const [box, text] of phrases) {
        if (text.replace(/\s+/gu, " ").trim() !== aiLine || smallest.get(box) < 14) continue;
        const rect = box.getBoundingClientRect();
        if (rect.width > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= 1080 && rect.bottom <= 1350) {
          box.dataset.aiLine = "1";
          aiBox = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
          break;
        }
      }
    }
    return { texts, cut, generated, colours: [...colours], phrases: [...phrases.values()], aiBox };
  }, [BRAND_RGB, usedAi.length > 0 ? AI_LINE[locale] : null]);

  const normal = (text) => text.replace(/\s+/gu, " ").trim();
  if (found.generated.length > 0) fail(`CSS may not draw text: ${JSON.stringify(found.generated)}`);
  if (found.texts.length === 0) fail("the card shows no words");
  if (found.cut.length > 0) fail(`lines cut off or outside the card: ${JSON.stringify(found.cut)}`);
  if (found.colours.length > 0) fail(`colours outside the brand palette: ${JSON.stringify(found.colours)}`);
  if (usedAi.length > 0) {
    // Seen, not merely present: the card's pixels where the line sits must
    // change visibly when the line is hidden -- whatever colour, opacity,
    // filter or cover the layout gave it.
    const aiMessage = `a card with an AI-made photo shows the line "${AI_LINE[locale]}" where it can be read: its own element, at least 14 px, inside the card and visible`;
    if (!found.aiBox) fail(aiMessage);
    const clip = { x: Math.floor(found.aiBox.x), y: Math.floor(found.aiBox.y), width: Math.ceil(found.aiBox.width), height: Math.ceil(found.aiBox.height) };
    const shown = await page.screenshot({ clip, type: "png" });
    // Only the letters go: the box's background, border and anything else stay,
    // so a coloured box behind invisible letters does not count as the line.
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.id = "ai-line-off";
      style.textContent = "[data-ai-line], [data-ai-line] * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }";
      document.head.append(style);
    });
    const hidden = await page.screenshot({ clip, type: "png" });
    await page.evaluate(() => document.getElementById("ai-line-off").remove());
    const changed = await page.evaluate(async ([a, b]) => {
      const pixels = async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height).data;
      };
      const [pa, pb] = [await pixels(a), await pixels(b)];
      let differing = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 60) differing += 1;
      }
      return differing / (pa.length / 4);
    }, [shown.toString("base64"), hidden.toString("base64")]);
    if (changed < 0.03) fail(aiMessage);
  }
  // A versioned model name must be one features.json lists, so a card cannot
  // name a model Tomverse does not offer ("GPT 7"). A bare family name
  // ("GPT, Claude, Gemini") is fine. Read per phrase, so a name split across
  // inline elements is read whole.
  for (const text of found.phrases.map(normal)) {
    for (const match of text.matchAll(MODEL_MENTION)) {
      // The listed name, then a boundary and no further version: "GPT 6 Luna"
      // passes, "GPT 6 Lunax" and "GPT 6 Luna 999" do not.
      const listed = (name) =>
        text.startsWith(name, match.index) && !/^(?:[\p{L}\p{N}]|\s*[\d.]+)/u.test(text.slice(match.index + name.length));
      if (!KNOWN_MODELS.some(listed)) {
        fail(`"${match[0]}" is not a model name in features.json`);
      }
    }
  }
  await page.screenshot({ path: pngPath, type: "png" });

  const today = path.basename(path.resolve(outDir));
  const mine = await differenceHash(page, pngPath);
  for (const earlier of earlierCards(today)) {
    const theirs = await differenceHash(page, earlier);
    let distance = 0;
    for (let i = 0; i < mine.length; i += 1) if (mine[i] !== theirs[i]) distance += 1;
    if (distance < MIN_HASH_DISTANCE) {
      fail(`looks like ${path.basename(earlier)} (hash distance ${distance} < ${MIN_HASH_DISTANCE}): change the composition and the pictures, not only the words`);
    }
  }
  // Phrase by phrase, as a reader reads them: inline pieces joined as they
  // stand ("<span>cheap</span>er" reads "cheaper"), boxes on their own lines.
  cardLines = found.phrases.map(normal).filter(Boolean);
} finally {
  await browser.close();
}

// Every word the card shows, for the Guard at submission: its own lines and
// the words inside the captures it used.
// A Chinese full stop with a word straight after it reads as a domain
// ("Luna。Claude", refused 2026-11-08), so it always has a space after it.
const spaced = (text) => text.replace(/。(?=\S)/gu, "。 ");
const transcript = spaced(
  [
    ...(generated ? cardLines.filter((line) => line !== BAND_ADDRESS) : cardLines),
    ...usedCaptures.map((name) => captures[name].text).filter(Boolean),
    ...pictureTexts.map((text) => text.replace(/\s+/gu, " ").trim()),
  ].join(String.fromCharCode(10)),
);
const alt = spaced(spec.alt.trim());
if (generated) {
  // The Guard's own hygiene rules, run here so a card is not refused for them
  // after its pictures were paid for (lib/marketingGuardNormalise.ts, which
  // imports nothing). esbuild strips its types, so any Node runs it: the box's
  // Node could not import a .ts file itself (first run, 2026-11-10).
  let hygiene;
  try {
    const { transform } = await import("esbuild");
    const source = readFileSync(path.resolve(toolDir, "..", "..", "lib", "marketingGuardNormalise.ts"), "utf8");
    const { code } = await transform(source, { loader: "ts", format: "esm" });
    ({ marketingTextHygiene: hygiene } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`));
  } catch (error) {
    fail(`the Guard's hygiene check could not be loaded: ${error instanceof Error ? error.message : error}`);
  }
  const codes = [...new Set([...hygiene(transcript), ...hygiene(alt)])];
  if (codes.length > 0) fail(`the words would fail the Guard's hygiene check: ${JSON.stringify(codes)}`);
}
const channels = (generated ? GENERATED_CHANNELS : CARD_CHANNELS)[locale];
const ai = usedAi.length > 0;
const validUntil = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
writeFileSync(
  path.join(outDir, `${spec.id}.asset.json`),
  JSON.stringify(
    {
      asset: {
        id: spec.id,
        // The library's photos are model-made pictures with our words set on
        // them, so the asset is AI generated (lib/marketingAssets.ts).
        provenance: ai ? "ai_generated" : usedCaptures.length > 0 ? "capture" : "operator_upload",
        allowedChannels: channels,
        // A card with captures keeps its source short's claims. A card without
        // them declares none: a feature claim needs its FAQ paragraph verbatim
        // in the words (the Guard's feature_not_public), which neither the card
        // nor a post carrying it could hold; its stated facts go to a person
        // through the Guard's undeclared_fact. The owner decides on 2026-11-07
        // whether the Guard should check an asset's feature gate instead.
        claimIds: usedCaptures.length > 0 ? packClaimIds : [],
        validUntil,
        disclosure: Object.fromEntries(channels.map((channel) => [channel, ai ? "caption_disclosure" : "none"])),
        // An AI picture that shows a Tomverse screen is not the product
        // interface itself (policy §7.3, owner 2026-11-08): only captures are.
        depictsProductInterface: usedCaptures.length > 0,
        alt: { [locale]: alt },
      },
      transcript: { [locale]: transcript },
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ made: spec.id, png: pngPath, pictures: used.map((pair) => pair.join(":")) }));
