// Checks the research call's answer and, only if it passes, writes it as the
// notes the copy-writing call may read (docs/policy/marketing-automation.md §2:
// external text is data; only structured results reach the model that writes
// copy). The research call itself cannot write files.
//   node check-research-notes.mjs <answer.txt> <ads.json> <notes-out.json>
// Exit 0 when the answer holds notes of the agreed shape, every brand is one of
// research-brands.json and no string carries a run of five words from any ad;
// 1 otherwise (nothing is written); 2 usage.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [answerPath, adsPath, outPath] = process.argv.slice(2);
if (!answerPath || !adsPath || !outPath) {
  console.error("usage: node check-research-notes.mjs <answer.txt> <ads.json> <notes-out.json>");
  process.exit(2);
}
const fail = (message) => {
  console.error(JSON.stringify({ step: "check-research-notes", error: message }));
  process.exit(1);
};
if (!existsSync(answerPath)) fail("no answer was saved");

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const BRANDS = JSON.parse(readFileSync(path.join(toolDir, "research-brands.json"), "utf8")).map((brand) => brand.name);
const FEATURES = ["chat", "review", "analysis", "images", "files", "assistants", "web-search"];
const MAX = 160;

// The notes are the answer's one JSON line with devices in it.
let notes = null;
for (const line of readFileSync(answerPath, "utf8").split(/\r?\n/u)) {
  try {
    const value = JSON.parse(line.trim());
    if (value && typeof value === "object" && "devices" in value) {
      notes = value;
      break;
    }
  } catch {
    // not the notes line
  }
}
if (!notes) fail("the answer holds no notes");

const isText = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= MAX;
const list = (value, max) => Array.isArray(value) && value.length <= max && value.every(isText);

const keys = Object.keys(notes).sort().join(",");
if (keys !== "colours,date,devices,formats,new,type") fail(`unexpected keys: ${keys}`);
if (!/^\d{4}-\d{2}-\d{2}$/u.test(notes.date)) fail("date is not yyyy-mm-dd");
if (!Array.isArray(notes.devices) || notes.devices.length < 4 || notes.devices.length > 10) fail("devices: 4-10 entries");
for (const device of notes.devices) {
  if (Object.keys(device ?? {}).sort().join(",") !== "borrowFor,device,look,seenAt") fail("a device has other keys");
  if (!isText(device.device) || !isText(device.look)) fail("a device field is missing or too long");
  if (!Array.isArray(device.seenAt) || device.seenAt.length === 0 || !device.seenAt.every((brand) => BRANDS.includes(brand))) {
    fail(`seenAt names only brands of research-brands.json: ${JSON.stringify(device.seenAt)}`);
  }
  if (!FEATURES.includes(device.borrowFor)) fail(`borrowFor is not a feature: ${device.borrowFor}`);
}
for (const field of ["formats", "type", "colours", "new"]) if (!list(notes[field], 6)) fail(`${field}: at most 6 strings of ${MAX} characters`);

// No run of five words from any ad, in any string the writer will read.
const words = (text) => text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}$€£₩¥%]+/gu) ?? [];
const runs = new Set();
const ads = existsSync(adsPath) ? JSON.parse(readFileSync(adsPath, "utf8")) : [];
for (const ad of ads) {
  const w = words(String(ad.body ?? ""));
  for (let i = 0; i + 5 <= w.length; i += 1) runs.add(w.slice(i, i + 5).join(" "));
}
const strings = [
  notes.date,
  ...notes.devices.flatMap((device) => [device.device, device.look, device.borrowFor, ...device.seenAt]),
  ...notes.formats,
  ...notes.type,
  ...notes.colours,
  ...notes.new,
];
for (const text of strings) {
  const w = words(text);
  for (let i = 0; i + 5 <= w.length; i += 1) {
    if (runs.has(w.slice(i, i + 5).join(" "))) fail(`the notes carry an ad's words: "${w.slice(i, i + 5).join(" ")}"`);
  }
}

mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(notes, null, 1)}\n`);
console.log(JSON.stringify({ ok: true, devices: notes.devices.length, notes: outPath }));
