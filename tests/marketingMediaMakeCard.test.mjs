import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";

/**
 * The media job researches the market's ads and designs each card with its own
 * words (owner 2026-11-07); a person approves every card in Admin. make-card
 * keeps what the job cannot be trusted to keep -- only library and capture
 * pictures, brand colours, nothing cut off, the AI line on an AI photo and no
 * AI photo beside a product capture, no look an earlier day or an example
 * already used -- and hands every visible word to the Guard. The tool has its
 * own packages (tools/marketing-video, installed on the AMUX box), so these run
 * where they are installed and are skipped elsewhere.
 */

const tool = resolve("tools/marketing-video");
const installed = existsSync(join(tool, "node_modules/playwright"));
const skip = installed ? false : "tools/marketing-video packages are not installed";

/** A small striped PNG: what a capture shows does not matter here, only that it is a picture. */
function stripes(rgb) {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) raw.set((x + y) % 16 < 8 ? rgb : [255, 255, 255], y * (width * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "make-card-"));
  const packDir = join(root, "sources", "media-x-short");
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "a.png"), stripes([21, 93, 251]));
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify({ assetId: "media-x-short", locale: "en", captures: { a: { file: "a.png", text: "answer A words" } } }),
  );
  return { root, pack: join(packDir, "pack.json") };
}

function make({ root, pack }, day, id, layout, extra = {}) {
  const out = join(root, day);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${id}.layout.html`), layout);
  const spec = { id, locale: "en", layout: `${id}.layout.html`, alt: "A test card for the make-card checks.", ...extra };
  if (spec.pack === true) spec.pack = pack;
  writeFileSync(join(out, `${id}.spec.json`), JSON.stringify(spec));
  return spawnSync(process.execPath, ["make-card.mjs", join(out, `${id}.spec.json`), out], { cwd: tool, encoding: "utf8" });
}
const asset = (root, day, id) => JSON.parse(readFileSync(join(root, day, `${id}.asset.json`), "utf8"));

const chips = (h1, h2, bg = "#155dfb") => `<style>
  body { background: ${bg}; }
  .h { position: absolute; left: 64px; font-family: 'Instrument Serif', serif; font-size: 96px; white-space: nowrap; color: #ffffff; }
  .chip { position: absolute; display: inline-flex; gap: 10px; align-items: center; padding: 12px 20px; border-radius: 16px; background: #fff; font-size: 26px; }
  .chip img { width: 30px; height: 30px; }
</style>
<div class="h" style="top:90px">${h1}</div>
<div class="h" style="top:200px;color:#eff6ff;font-style:italic">${h2}</div>
<div class="chip" style="left:80px;top:520px"><img src="library:logo-openai"><span>GPT 6 Luna</span></div>
<div class="chip" style="left:420px;top:600px"><img src="library:logo-claude"><span>Claude Sonnet 5.5</span></div>
<div style="position:absolute;left:64px;bottom:60px;font-size:30px;color:#ffffff">Tomverse</div>`;

const dark = `<style>
  body { background: #18181b; }
  .shot { position: absolute; top: 0; width: 540px; height: 1350px; object-fit: cover; }
  .h { position: absolute; left: 64px; bottom: 260px; font-size: 96px; font-weight: 900; color: #ffffff; white-space: nowrap; }
</style>
<img class="shot" style="left:0" src="capture:a">
<img class="shot" style="left:540px;opacity:.4" src="library:tomverse-logo">
<div class="h">Which one</div>
<div class="h" style="bottom:150px;color:#eff6ff">do you trust?</div>`;

const photo = (line) => `<style>body { background: url(library:photo-receipt) 40% 30% / 320% no-repeat; } .veil { position:absolute; inset:0; background: rgba(24,24,27,.55); }</style><div class="veil"></div>
<div style="position:absolute;left:0;right:0;top:900px;text-align:center;font-size:88px;color:#ffffff">Answers, itemised.</div>
${line ? `<div style="position:absolute;right:28px;bottom:24px;font-size:16px;color:#ffffff">${line}</div>` : ""}`;

test("a card of library pictures and the job's own words is written with every word in its transcript", { skip }, () => {
  const ctx = setup();
  try {
    const out = make(ctx, "20261101", "media-20261101-chat-en-card", chips("Every AI,", "one place."));
    assert.equal(out.status, 0, out.stderr);
    const { asset: entry, transcript } = asset(ctx.root, "20261101", "media-20261101-chat-en-card");
    assert.equal(entry.provenance, "operator_upload");
    assert.equal(entry.depictsProductInterface, false);
    assert.deepEqual(entry.claimIds, []);
    assert.deepEqual(entry.allowedChannels, ["facebook", "instagram", "linkedin", "x"]);
    assert.equal(entry.disclosure.x, "none");
    assert.equal(transcript.en, "Every AI, one place. GPT 6 Luna Claude Sonnet 5.5 Tomverse");
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("a capture makes a capture asset whose transcript carries the capture's words", { skip }, () => {
  const ctx = setup();
  try {
    const out = make(ctx, "20261101", "media-20261101-review-en-card", dark, { pack: true });
    assert.equal(out.status, 0, out.stderr);
    const { asset: entry, transcript } = asset(ctx.root, "20261101", "media-20261101-review-en-card");
    assert.equal(entry.provenance, "capture");
    assert.equal(entry.depictsProductInterface, true);
    assert.match(transcript.en, /Which one do you trust\? answer A words$/u);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("an AI photo needs the locale's AI line, makes an ai_modified asset, and never sits beside a capture", { skip }, () => {
  const ctx = setup();
  try {
    const bare = make(ctx, "20261101", "media-a-card", photo(""));
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /Photo: AI-generated/u);
    const labelled = make(ctx, "20261101", "media-b-card", photo("Photo: AI-generated"));
    assert.equal(labelled.status, 0, labelled.stderr);
    const { asset: entry } = asset(ctx.root, "20261101", "media-b-card");
    assert.equal(entry.provenance, "ai_modified");
    assert.equal(entry.disclosure.instagram, "caption_disclosure");
    const mixed = make(ctx, "20261101", "media-c-card", `${photo("Photo: AI-generated")}<img src="capture:a" style="position:absolute;left:0;top:400px;width:300px">`, { pack: true });
    assert.equal(mixed.status, 1);
    assert.match(mixed.stderr, /may not share a card/u);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("pictures from anywhere else, script, CSS text, form fields and list markers are refused", { skip }, () => {
  const ctx = setup();
  try {
    for (const [extra, reason] of [
      ['<img src="https://example.com/x.png">', /not captures or library entries/u],
      ['<div style="background:url(file:///etc/x.png)"></div>', /not captures or library entries/u],
      ['<img src="library:nope">', /not captures or library entries/u],
      ['<img src="capture:a">', /not captures or library entries/u],
      ["<script>1</script>", /only HTML, CSS/u],
      ['<input value="Free">', /only HTML, CSS/u],
      ["<style>.h::after{content:\" now\"}</style>", /CSS may not draw text/u],
      ['<ol><li style="position:absolute;top:0"></li></ol>', /CSS may not draw text/u],
    ]) {
      const out = make(ctx, "20261101", "media-a-card", chips("Every AI,", "one place.") + extra);
      assert.equal(out.status, 1, extra);
      assert.match(out.stderr, reason, extra);
    }
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("a colour outside the brand palette is refused; brand colours at any opacity pass", { skip }, () => {
  const ctx = setup();
  try {
    const red = make(ctx, "20261101", "media-a-card", chips("Every AI,", "one place.", "#ff0000"));
    assert.equal(red.status, 1);
    assert.match(red.stderr, /brand palette/u);
    const faded = make(ctx, "20261101", "media-b-card", chips("Every AI,", "one place.", "rgba(21, 93, 251, 0.9)"));
    assert.equal(faded.status, 0, faded.stderr);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("a line pushed off the card is refused", { skip }, () => {
  const ctx = setup();
  try {
    const out = make(ctx, "20261101", "media-a-card", chips("Every AI,", "one place.").replace("left: 64px; font-family", "left: 760px; font-family"));
    assert.equal(out.status, 1);
    assert.match(out.stderr, /cut off/u);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("an earlier day's look with new words is refused; a new composition and a same-day sibling pass", { skip }, () => {
  const ctx = setup();
  try {
    assert.equal(make(ctx, "20261101", "media-20261101-x-en-card", chips("Every AI,", "one place.")).status, 0);
    const reworded = make(ctx, "20261102", "media-20261102-x-en-card", chips("All models,", "one tab."));
    assert.equal(reworded.status, 1);
    assert.match(reworded.stderr, /looks like media-20261101-x-en-card\.png/u);
    const fresh = make(ctx, "20261102", "media-20261102-x-en-card", dark, { pack: true });
    assert.equal(fresh.status, 0, fresh.stderr);
    const sibling = make(ctx, "20261102", "media-20261102-x-ko-card", dark, { pack: true, locale: "ko" });
    assert.equal(sibling.status, 0, sibling.stderr);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("the approved examples are compared too, so a copy of one is refused", { skip }, () => {
  const ctx = setup();
  try {
    const layout = readFileSync(join(tool, "examples", "every-ai.layout.html"), "utf8");
    const copy = make(ctx, "20261101", "media-20261101-copy-en-card", layout);
    assert.equal(copy.status, 1);
    assert.match(copy.stderr, /looks like every-ai\.png/u);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("a zh-Hans card goes to RedNote and the ko card to Threads", { skip }, () => {
  const ctx = setup();
  try {
    const zh = make(ctx, "20261101", "media-a-zh-hans-card", chips("同一个问题，", "三个答案。"), { locale: "zh-Hans" });
    assert.equal(zh.status, 0, zh.stderr);
    assert.deepEqual(asset(ctx.root, "20261101", "media-a-zh-hans-card").asset.allowedChannels, ["rednote"]);
    const ko = make(ctx, "20261101", "media-a-ko-card", chips("모든 AI를", "한곳에서."), { locale: "ko" });
    assert.equal(ko.status, 0, ko.stderr);
    assert.deepEqual(asset(ctx.root, "20261101", "media-a-ko-card").asset.allowedChannels, ["facebook", "instagram", "threads"]);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});
