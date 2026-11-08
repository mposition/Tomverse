// Deterministic picture steps of the Higgsfield image path (owner 2026-11-08).
// Positions come from the review's boxes, never from this file.
//
//   node compose.mjs logos <in> <review.json> <out.png>
//     Paints every flat provider mark over with the real file
//     (public/model-icons/<logo>.png): a soft cover in the colour just right
//     of the mark, then the file (white background) multiplied onto it.
//   node compose.mjs texts <in> <review.json> <concepts.json> <concept id> <locale> <out.png> --roles headline,cta|screen
//     Sets the locale's approved words in the product fonts (Geist, Noto Sans
//     KR/TC/SC; docs/ui-contracts/typography.md) in the review's text boxes of
//     those roles. Korean and Chinese words are never drawn by the image model
//     (owner 2026-11-08): headlines go on the cleared space; screen words are
//     set over a fill of the screen's colour, then smoothed by one edit.
// Exit 0 written, 1 anything else, 2 usage.
import { readFileSync } from "node:fs";

import { setLogos, setTexts } from "./compose-core.mjs";

const [mode, ...rest] = process.argv.slice(2);
const fail = (message, code = 1) => {
  console.error(JSON.stringify({ step: `compose-${mode}`, error: message }));
  process.exit(code);
};
try {
  if (mode === "logos" && rest.length === 3) {
    const [input, reviewPath, out] = rest;
    const drawn = await setLogos({ input, review: JSON.parse(readFileSync(reviewPath, "utf8")), out });
    console.log(JSON.stringify({ step: "compose-logos", out, drawn }));
  } else if (mode === "texts" && rest.length === 8 && rest[6] === "--roles") {
    const [input, reviewPath, conceptsPath, id, locale, out, , roles] = rest;
    const concept = JSON.parse(readFileSync(conceptsPath, "utf8")).concepts.find((entry) => entry.id === id);
    if (!concept) fail(`no concept ${id}`);
    const set = await setTexts({ input, review: JSON.parse(readFileSync(reviewPath, "utf8")), concept, locale, roles: roles.split(","), out });
    console.log(JSON.stringify({ step: "compose-texts", out, set }));
  } else {
    fail("usage: node compose.mjs logos <in> <review.json> <out> | texts <in> <review.json> <concepts.json> <id> <locale> <out> --roles <roles>", 2);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
