// Renders a creative short's film, written by the build call in
// <run>/film/Film.tsx, for one locale:
//   node render-creative.mjs <run-dir> <locale> --stills [count]   -> <run>/review/<locale>/f-NN.png
//   node render-creative.mjs <run-dir> <locale> --out <run>/out/<file>.mp4
//   node render-creative.mjs <run-dir> <locale> --blocks             -> <run>/kit/blocks-<locale>.json
// Each run first copies the creative kit into <run>/kit and writes the ink grid
// of the locale's captures there (creative-layout.mjs), and the blocks of words
// the film's Screen can crop.
// The film's code is checked first (creative-core.mjs checkFilmSource) and is
// refused before it is bundled. Its props are <run>/public/props-<locale>.json,
// and <run>/public is the only folder it can load files from (staticFile).
// The entry that registers the composition is written here, not by the model.
// A final render is mastered to -14 LUFS. Exit 0 rendered, 2 usage or a path
// outside the run, 3 the film's code refused, 1 anything else.
//
// The film is a model's code, so it is bundled and rendered in a sandbox: this
// script runs itself again under bubblewrap with no network (loopback only,
// for the renderer's own page server), an environment of PATH, HOME and LANG
// only, and the home folders that hold logins and keys hidden. Without
// bubblewrap on Linux it refuses; elsewhere (a developer's machine) it runs
// only with CREATIVE_RENDER_UNSANDBOXED=1, and with the same bare environment.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";

import { AI_LINE, checkFilmSource } from "./creative-core.mjs";
import { blocksOf, readGrid } from "./creative-kit/geometry.js";
import { gridOfFile } from "./creative-layout.mjs";
import { master } from "./ffmpeg-tools.mjs";

export const FPS = 30;
const INSIDE = "CREATIVE_RENDER_SANDBOX";
/** Home entries that hold logins, keys and the job's secrets; hidden from the render. */
export const HIDDEN = [".config/tomverse", ".config/higgsfield", ".config/gh", ".claude", ".claude.json", ".codex", ".copilot", ".cursor", ".amux", ".ssh", ".gnupg", ".netrc", ".npmrc", ".git-credentials", ".aws", ".docker"];

if (process.env[INSIDE] !== "inside") {
  const home = os.homedir();
  const bare = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: process.env.LANG ?? "C.UTF-8", [INSIDE]: "inside" };
  const self = [fileURLToPath(import.meta.url), ...process.argv.slice(2)];
  let ran;
  if (process.platform === "linux") {
    const hide = HIDDEN.map((entry) => path.join(home, entry)).filter((entry) => existsSync(entry)).flatMap((entry) => (lstatSync(entry).isDirectory() ? ["--tmpfs", entry] : ["--ro-bind", "/dev/null", entry]));
    ran = spawnSync("bwrap", ["--dev-bind", "/", "/", "--unshare-net", "--die-with-parent", "--new-session", ...hide, process.execPath, ...self], { stdio: "inherit", env: bare });
  } else if (process.env.CREATIVE_RENDER_UNSANDBOXED === "1") {
    ran = spawnSync(process.execPath, self, { stdio: "inherit", env: { ...bare, SystemRoot: process.env.SystemRoot ?? "" } });
  } else {
    console.log(JSON.stringify({ step: "render-creative", error: "no sandbox here: run on the Linux box (bubblewrap), or set CREATIVE_RENDER_UNSANDBOXED=1 on a developer's machine" }));
    process.exit(1);
  }
  if (ran.error) {
    console.log(JSON.stringify({ step: "render-creative", error: `the sandbox did not start: ${ran.error.message}` }));
    process.exit(1);
  }
  process.exit(ran.status ?? 1);
}
const usage = () => {
  console.error("usage: node render-creative.mjs <run-dir> <locale> --stills [count] | --out <run-dir>/out/<file>.mp4 | --blocks");
  process.exit(2);
};

const [runArg, locale, mode, value] = process.argv.slice(2);
if (!runArg || !locale || !["--stills", "--out", "--blocks"].includes(mode ?? "")) usage();
const run = path.resolve(runArg);
const inside = (file) => !path.relative(run, file).startsWith("..") && !path.isAbsolute(path.relative(run, file));
if (!/^[a-zA-Z-]{2,7}$/u.test(locale)) usage();
// Checked before bundling: usage() exits, which would skip the bundle cleanup.
const out = mode === "--out" ? path.resolve(value ?? "") : null;
if (out !== null && (!value || !inside(out) || !out.endsWith(".mp4"))) usage();

// The kit, fresh from the job's own copy (an edit in the run's copy is undone), and the ink grid
// of each of this locale's captures, which its Screen keeps crops in the gaps of.
const kitDir = path.join(run, "kit");
rmSync(kitDir, { recursive: true, force: true });
cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "creative-kit"), kitDir, { recursive: true });
let props;
try {
  props = JSON.parse(readFileSync(path.join(run, "public", `props-${locale}.json`), "utf8"));
} catch (error) {
  console.log(JSON.stringify({ step: "render-creative", error: `no props for ${locale}: ${String(error?.message ?? error).split("\n")[0]}` }));
  process.exit(1);
}
const layout = {};
for (const capture of Array.isArray(props.captures) ? props.captures : []) {
  const file = path.join(run, "public", String(capture.file));
  if (!inside(file)) usage();
  layout[capture.name] = gridOfFile(file);
}
writeFileSync(path.join(kitDir, `layout-${locale}.json`), JSON.stringify(layout));
// The blocks of words in each capture, the crops Screen takes as they are: the builder reads them.
const blocks = Object.fromEntries(Object.entries(layout).map(([name, entry]) => [name, blocksOf(readGrid(entry))]));
writeFileSync(path.join(kitDir, `blocks-${locale}.json`), `{\n${Object.entries(blocks).map(([name, list]) => `${JSON.stringify(name)}: [\n${list.map((block) => `  ${JSON.stringify(block)}`).join(",\n")}\n]`).join(",\n")}\n}\n`);
if (mode === "--blocks") {
  console.log(JSON.stringify({ step: "render-creative", locale, blocks: path.relative(run, path.join(kitDir, `blocks-${locale}.json`)) }));
  process.exit(0);
}

const problems = await checkFilmSource(path.join(run, "film"));
if (problems.length > 0) {
  console.log(JSON.stringify({ step: "render-creative", refused: problems }));
  process.exit(3);
}


const entry = path.join(run, "entry.tsx");
writeFileSync(
  entry,
  `import React from "react";
import { Composition, registerRoot } from "remotion";
import { KitRoot, type FilmProps } from "./kit";
import layout from "./kit/layout-${locale}.json";
// The brand faces, from the box's node_modules (it has no CJK system fonts):
// "Geist Variable", "Instrument Serif", "Noto Sans KR/TC/SC Variable".
import "@fontsource-variable/geist";
import "@fontsource/instrument-serif";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/noto-sans-kr";
import "@fontsource-variable/noto-sans-tc";
import "@fontsource-variable/noto-sans-sc";
import { Film } from "./film/Film";

const Framed = (props: Record<string, unknown>) => (
  <KitRoot props={props as unknown as FilmProps} aiLine={${JSON.stringify(AI_LINE[locale] ?? "")}} layout={layout} final={${mode === "--out"}}>
    <Film {...props} />
  </KitRoot>
);
const Root = () => (
  <Composition
    id="Creative"
    component={Framed}
    width={1080}
    height={1920}
    fps={${FPS}}
    durationInFrames={${FPS * 10}}
    calculateMetadata={({ props }: { props: Record<string, unknown> }) => ({ durationInFrames: Math.round(Number(props.seconds) * ${FPS}) })}
  />
);
registerRoot(Root);
`,
);

// bundle() copies the run's public media into a fresh temp folder and never
// removes it: 65 left behind filled the box's /tmp quota (EDQUOT, 2026-11-11).
let serveUrl = null;
try {
  const inputProps = props;
  serveUrl = await bundle({ entryPoint: entry, publicDir: path.join(run, "public") });
  const composition = await selectComposition({ serveUrl, id: "Creative", inputProps });

  if (mode === "--stills") {
    const count = Math.min(24, Math.max(4, Number(value) || 12));
    const dir = path.join(run, "review", locale);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const files = [];
    for (let index = 0; index < count; index += 1) {
      const frame = Math.min(composition.durationInFrames - 1, Math.round(((index + 0.5) / count) * composition.durationInFrames));
      const output = path.join(dir, `f-${String(index + 1).padStart(2, "0")}-${(frame / FPS).toFixed(1)}s.png`);
      await renderStill({ composition, serveUrl, frame, output, inputProps, scale: 0.5 });
      files.push(path.relative(run, output));
    }
    console.log(JSON.stringify({ step: "render-creative", locale, stills: files }));
  } else {
    mkdirSync(path.dirname(out), { recursive: true });
    const raw = `${out}.raw.mp4`;
    await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: raw, inputProps });
    master(raw, out);
    rmSync(raw, { force: true });
    console.log(JSON.stringify({ step: "render-creative", locale, out: path.relative(run, out), frames: composition.durationInFrames }));
  }
} catch (error) {
  // The error's first line only: a bundling error names the film's file and line.
  console.log(JSON.stringify({ step: "render-creative", error: String(error?.message ?? error).split("\n").slice(0, 6).join("\n") }));
  process.exitCode = 1;
} finally {
  if (serveUrl) rmSync(serveUrl, { recursive: true, force: true });
}
// Exit now: a browser Remotion left open must not keep a failed render alive.
if (process.exitCode) process.exit(process.exitCode);
