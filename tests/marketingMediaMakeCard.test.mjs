import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";

/**
 * The media job designs each card itself (owner 2026-11-07: no card that only
 * changes its words); make-card.mjs keeps what the job cannot be trusted to
 * keep -- the pack's lines, its captures, the brand colours, nothing cut off,
 * and no look an earlier day already used. The tool has its own packages
 * (tools/marketing-video, installed on the AMUX box), so these run where they
 * are installed and are skipped elsewhere.
 */

const tool = resolve("tools/marketing-video");
const installed = existsSync(join(tool, "node_modules/opencc-js")) && existsSync(join(tool, "node_modules/playwright"));
const skip = installed ? false : "tools/marketing-video packages are not installed";

/** A small striped PNG: what a capture shows does not matter here, only that it is a picture. */
function stripes(rgb) {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const on = (x + y) % 16 < 8;
      raw.set(on ? rgb : [255, 255, 255], y * (width * 3 + 1) + 1 + x * 3);
    }
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

function setup(locale = "en") {
  const root = mkdtempSync(join(tmpdir(), "make-card-"));
  const packDir = join(root, "sources", "media-x-short");
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "a.png"), stripes([21, 93, 251]));
  writeFileSync(join(packDir, "b.png"), stripes([24, 24, 27]));
  writeFileSync(join(packDir, "src.asset.json"), JSON.stringify({ asset: { claimIds: ["claim-1"] } }));
  const zh = locale === "zh-Hant";
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify({
      assetId: "media-x-short",
      locale,
      topic: "review-compare",
      question: zh ? ["同一個問題"] : ["Same question for three models"],
      headlines: zh ? [["同一個問題，", "不同的答案。"]] : [["Same question,", "different answers."], ["Which one", "do you trust?"]],
      callouts: zh ? ["直接看來源。"] : ["Straight to the source."],
      ctas: zh ? ["只要問一次 →"] : ["With Review, ask just once →"],
      cardAlt: zh ? "卡片" : "A card",
      captures: { a: { file: "a.png", text: "answer A words" }, b: { file: "b.png", text: "answer B words" } },
      videoAsset: "src.asset.json",
    }),
  );
  return { root, pack: join(packDir, "pack.json") };
}

function make({ root, pack }, day, id, layout, extra = {}) {
  const out = join(root, day);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${id}.layout.html`), layout);
  writeFileSync(join(out, `${id}.spec.json`), JSON.stringify({ id, layout: `${id}.layout.html`, ...extra }));
  return spawnSync(process.execPath, ["make-card.mjs", pack, join(out, `${id}.spec.json`), out], { cwd: tool, encoding: "utf8" });
}

const top = (h1, h2, bg = "#ffffff", ink = "#18181b") => `<style>
  body { background: ${bg}; }
  .h { position: absolute; left: 64px; font-size: 88px; font-weight: 900; color: ${ink}; white-space: nowrap; }
  .shot { position: absolute; left: 64px; top: 420px; width: 952px; height: 760px; border-radius: 32px; object-fit: cover; }
</style>
<div class="h" style="top:80px">${h1}</div>
<div class="h" style="top:200px;color:#155dfb">${h2}</div>
<img class="shot" src="capture:a">
<div style="position:absolute;left:64px;bottom:60px;font-size:36px;font-weight:800">Tomverse</div>`;

const split = `<style>
  body { background: #18181b; }
  .shot { position: absolute; top: 0; width: 540px; height: 1350px; object-fit: cover; }
  .h { position: absolute; left: 64px; bottom: 260px; font-size: 96px; font-weight: 900; color: #ffffff; white-space: nowrap; }
</style>
<img class="shot" style="left:0" src="capture:b">
<img class="shot" style="left:540px;opacity:.4" src="capture:a">
<div class="h">Which one</div>
<div class="h" style="bottom:150px;color:#eff6ff">do you trust?</div>`;

test("a card made of the pack's lines, captures and brand colours is written with its asset file", { skip }, () => {
  const ctx = setup();
  try {
    const out = make(ctx, "20261101", "media-20261101-review-compare-en-card", top("Same question,", "different answers."));
    assert.equal(out.status, 0, out.stderr);
    const dir = join(ctx.root, "20261101");
    assert.ok(existsSync(join(dir, "media-20261101-review-compare-en-card.png")));
    const asset = JSON.parse(readFileSync(join(dir, "media-20261101-review-compare-en-card.asset.json"), "utf8"));
    assert.deepEqual(asset.asset.claimIds, ["claim-1"]);
    assert.equal(asset.asset.provenance, "capture");
    // Only the captures the card used are in its transcript.
    assert.match(asset.transcript.en, /Same question, different answers\. .*answer A words/u);
    assert.doesNotMatch(asset.transcript.en, /answer B words/u);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("words the pack does not carry are refused", { skip }, () => {
  const ctx = setup();
  try {
    const out = make(ctx, "20261101", "media-a-card", top("Same question,", "better answers."));
    assert.equal(out.status, 1);
    assert.match(out.stderr, /not one of the pack's lines/u);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("a line split over two elements, CSS text, a form field and a list number are refused", { skip }, () => {
  const ctx = setup();
  try {
    for (const [layout, reason] of [
      [top("Same <b>question,</b>", "different answers."), /not one of the pack's lines/u],
      [`${top("Same question,", "different answers.")}<style>.h::after{content:" now"}</style>`, /CSS may not draw text/u],
      [`${top("Same question,", "different answers.")}<input value="Free">`, /only HTML, CSS/u],
      [`${top("Same question,", "different answers.")}<ol><li style="position:absolute;top:0"></li></ol>`, /CSS may not draw text/u],
    ]) {
      const out = make(ctx, "20261101", "media-a-card", layout);
      assert.equal(out.status, 1, layout);
      assert.match(out.stderr, reason);
    }
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("a picture from anywhere but the pack's captures, and a script, are refused", { skip }, () => {
  const ctx = setup();
  try {
    for (const extra of ['<img src="https://example.com/x.png">', '<div style="background:url(file:///etc/x.png)"></div>', '<img src="capture:nope">', "<script>1</script>"]) {
      const out = make(ctx, "20261101", "media-a-card", top("Same question,", "different answers.") + extra);
      assert.equal(out.status, 1, extra);
    }
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("a colour outside the brand palette is refused; brand colours at any opacity pass", { skip }, () => {
  const ctx = setup();
  try {
    const red = make(ctx, "20261101", "media-a-card", top("Same question,", "different answers.", "#ff0000"));
    assert.equal(red.status, 1);
    assert.match(red.stderr, /brand palette/u);
    const faded = make(ctx, "20261101", "media-b-card", top("Same question,", "different answers.", "rgba(21, 93, 251, 0.12)"));
    assert.equal(faded.status, 0, faded.stderr);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("a line pushed off the card is refused", { skip }, () => {
  const ctx = setup();
  try {
    const out = make(ctx, "20261101", "media-a-card", top("Same question,", "different answers.").replace("left: 64px; font-size: 88px", "left: 700px; font-size: 88px"));
    assert.equal(out.status, 1);
    assert.match(out.stderr, /cut off/u);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("an earlier day's look with new words is refused; a new composition passes", { skip }, () => {
  const ctx = setup();
  try {
    assert.equal(make(ctx, "20261101", "media-20261101-x-en-card", top("Same question,", "different answers.")).status, 0);
    const reworded = make(ctx, "20261102", "media-20261102-x-en-card", top("Which one", "do you trust?"));
    assert.equal(reworded.status, 1);
    assert.match(reworded.stderr, /looks like media-20261101-x-en-card\.png/u);
    const fresh = make(ctx, "20261102", "media-20261102-x-en-card", split);
    assert.equal(fresh.status, 0, fresh.stderr);
    // Today's other cards (the same design in another locale) are not compared.
    const sibling = make(ctx, "20261102", "media-20261102-x-ko-card", split);
    assert.equal(sibling.status, 0, sibling.stderr);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("a zh-Hans card names the zh-Hant pack's lines and draws them in Simplified", { skip }, () => {
  const ctx = setup("zh-Hant");
  try {
    const out = make(ctx, "20261101", "media-a-zh-hans-card", top("同一個問題，", "不同的答案。"), { locale: "zh-Hans" });
    assert.equal(out.status, 0, out.stderr);
    const asset = JSON.parse(readFileSync(join(ctx.root, "20261101", "media-a-zh-hans-card.asset.json"), "utf8"));
    assert.deepEqual(asset.asset.allowedChannels, ["rednote"]);
    assert.match(asset.transcript["zh-Hans"], /同一个问题，/u);
    const simplified = make(ctx, "20261101", "media-b-zh-hans-card", top("同一个问题，", "不同的答案。"), { locale: "zh-Hans" });
    assert.equal(simplified.status, 1);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});
