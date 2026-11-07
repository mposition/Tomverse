// Checks the research call's notes before the copy-writing call may read them
// (docs/policy/marketing-automation.md §2: external text is data; only
// structured results reach the model that writes copy).
//   node check-research-notes.mjs <notes.json> <ads.json>
// Exit 0 when the notes have the agreed shape and carry no run of five or more
// words from any ad; 1 otherwise (run-daily.sh then deletes them); 2 usage.
import { existsSync, readFileSync } from "node:fs";

const [notesPath, adsPath] = process.argv.slice(2);
if (!notesPath || !adsPath) {
  console.error("usage: node check-research-notes.mjs <notes.json> <ads.json>");
  process.exit(2);
}
const fail = (message) => {
  console.error(JSON.stringify({ step: "check-research-notes", error: message }));
  process.exit(1);
};
if (!existsSync(notesPath)) fail("no notes were written");

const FEATURES = ["chat", "review", "analysis", "images", "files", "assistants", "web-search"];
const MAX = 160;
let notes;
try {
  notes = JSON.parse(readFileSync(notesPath, "utf8"));
} catch {
  fail("the notes are not JSON");
}
const isText = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= MAX;
const list = (value, max) => Array.isArray(value) && value.length <= max && value.every(isText);

const keys = Object.keys(notes ?? {}).sort().join(",");
if (keys !== "colours,date,devices,formats,new,type") fail(`unexpected keys: ${keys}`);
if (!/^\d{4}-\d{2}-\d{2}$/u.test(notes.date)) fail("date is not yyyy-mm-dd");
if (!Array.isArray(notes.devices) || notes.devices.length < 4 || notes.devices.length > 10) fail("devices: 4-10 entries");
for (const device of notes.devices) {
  if (Object.keys(device ?? {}).sort().join(",") !== "borrowFor,device,look,seenAt") fail("a device has other keys");
  if (!isText(device.device) || !isText(device.look) || !list(device.seenAt, 9)) fail("a device field is missing or too long");
  if (!FEATURES.includes(device.borrowFor)) fail(`borrowFor is not a feature: ${device.borrowFor}`);
}
for (const field of ["formats", "type", "colours", "new"]) if (!list(notes[field], 6)) fail(`${field}: at most 6 strings of ${MAX} characters`);

// No run of five words from any ad, so an ad's copy cannot reach the writer.
const words = (text) => text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}$€£₩¥%]+/gu) ?? [];
const runs = new Set();
const ads = existsSync(adsPath) ? JSON.parse(readFileSync(adsPath, "utf8")) : [];
for (const ad of ads) {
  const w = words(String(ad.body ?? ""));
  for (let i = 0; i + 5 <= w.length; i += 1) runs.add(w.slice(i, i + 5).join(" "));
}
const strings = [
  ...notes.devices.flatMap((device) => [device.device, device.look]),
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
console.log(JSON.stringify({ ok: true, devices: notes.devices.length }));
