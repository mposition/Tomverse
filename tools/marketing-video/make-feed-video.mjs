// Makes the 4:5 feed version of an approved 9:16 short and writes the asset
// file the submission needs:
//   node make-feed-video.mjs <job/sources/<asset-id>/pack.json> <new-asset-id> <out-dir>
// The short is the approved file, unchanged and whole -- same picture, same
// voice -- set on a 1080x1350 brand-grey frame (the `Feed` composition) so the
// feeds that crop 9:16 (Facebook, LinkedIn, X, Threads) show all of it. Its
// words are the approved short's, so its transcript and alt text carry over.
//
// Exit codes: 0 written, 2 usage, 1 anything else.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [packPath, id, outDir] = process.argv.slice(2);
if (!packPath || !id || !outDir) {
  console.error("usage: node make-feed-video.mjs <pack.json> <new-asset-id> <out-dir>");
  process.exit(2);
}

/** The feeds a 4:5 video goes to, per locale; Instagram already carries the 9:16 short. */
const FEED_CHANNELS = {
  en: ["facebook", "linkedin", "x"],
  ko: ["facebook"],
  "zh-Hant": ["facebook", "threads"],
};

const fail = (message) => {
  console.error(JSON.stringify({ step: "make-feed-video", error: message }));
  process.exit(1);
};
if (!/^media-[a-z0-9][a-z0-9-]{0,99}$/u.test(id)) fail("the id is not a media asset id");

const pack = JSON.parse(readFileSync(packPath, "utf8"));
const packDir = path.dirname(path.resolve(packPath));
const channels = FEED_CHANNELS[pack.locale];
if (!channels) fail(`no feed channels for locale ${pack.locale}`);
const video = path.join(packDir, pack.video);
const source = path.join(packDir, pack.videoAsset);
if (!existsSync(video)) fail(`missing video ${video}`);
if (!existsSync(source)) fail(`missing asset file ${source}`);
const approved = JSON.parse(readFileSync(source, "utf8"));

const here = path.dirname(fileURLToPath(import.meta.url));
/** The ffprobe Remotion ships, or one on the PATH. */
const ffprobe = (() => {
  const dir = path.join(here, "node_modules", "@remotion");
  const compositor = existsSync(dir) ? readdirSync(dir).find((name) => name.startsWith("compositor-")) : undefined;
  return compositor ? path.join(dir, compositor, process.platform === "win32" ? "ffprobe.exe" : "ffprobe") : "ffprobe";
})();
const seconds = Number(
  execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], { encoding: "utf8" }).trim(),
);
if (!(seconds > 0)) fail("the short has no duration");

// The props and the short side by side: render.mjs serves the props' folder as static files.
const work = mkdtempSync(path.join(tmpdir(), "mv-feed-"));
copyFileSync(video, path.join(work, "short.mp4"));
writeFileSync(path.join(work, "props.json"), JSON.stringify({ video: "short.mp4", seconds }));
mkdirSync(outDir, { recursive: true });
const out = path.resolve(outDir, `${id}.mp4`);
execFileSync(process.execPath, [path.join(here, "render.mjs"), path.join(work, "props.json"), "Feed", out], {
  stdio: "inherit",
});

const validUntil = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
writeFileSync(
  path.join(outDir, `${id}.asset.json`),
  JSON.stringify(
    {
      asset: {
        id,
        provenance: approved.asset.provenance,
        allowedChannels: channels,
        claimIds: [...approved.asset.claimIds],
        validUntil,
        disclosure: Object.fromEntries(channels.map((channel) => [channel, "none"])),
        depictsProductInterface: approved.asset.depictsProductInterface,
        alt: approved.asset.alt,
      },
      transcript: approved.transcript,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ made: id, mp4: out }));
