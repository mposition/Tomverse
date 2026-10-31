// Renders one video: node render.mjs <props.json> <Short|Long> <out.mp4>
// Media named in the props are files beside props.json (served as static
// files) or https URLs. The props are validated by the composition metadata.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

const [propsPath, compositionId, outPath] = process.argv.slice(2);
if (!propsPath || !["Short", "Long"].includes(compositionId ?? "") || !outPath) {
  console.error("usage: node render.mjs <props.json> <Short|Long> <out.mp4>");
  process.exit(2);
}
const inputProps = JSON.parse(readFileSync(propsPath, "utf8"));
const here = path.dirname(fileURLToPath(import.meta.url));
const serveUrl = await bundle({
  entryPoint: path.join(here, "src", "index.ts"),
  publicDir: path.dirname(path.resolve(propsPath)),
});
const composition = await selectComposition({ serveUrl, id: compositionId, inputProps });
await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: outPath, inputProps });
console.log(JSON.stringify({ rendered: outPath, composition: compositionId, frames: composition.durationInFrames }));
