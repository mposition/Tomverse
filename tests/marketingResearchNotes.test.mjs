import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The research call reads competitors' ads; only its checked notes reach the
 * call that writes copy (owner 2026-11-07; docs/policy/marketing-automation.md
 * §2, external text is data). check-research-notes.mjs is that check: the
 * agreed shape, and no run of five words from any ad.
 */

const check = (notes, ads) => {
  const dir = mkdtempSync(join(tmpdir(), "research-notes-"));
  try {
    writeFileSync(join(dir, "notes.json"), typeof notes === "string" ? notes : JSON.stringify(notes));
    writeFileSync(join(dir, "ads.json"), JSON.stringify(ads));
    return spawnSync(process.execPath, ["tools/marketing-video/check-research-notes.mjs", join(dir, "notes.json"), join(dir, "ads.json")], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const ads = [{ brand: "x", body: "Every top model in one plan, cancel anytime and keep your chats forever." }];
const device = (look) => ({ device: "paper receipt", look, seenAt: ["runable"], borrowFor: "analysis" });
const good = {
  date: "2026-11-09",
  devices: [device("a long thermal slip with ruled rows"), device("app icons in a grid"), device("a ticket with a ribbon"), device("chips falling into a list")],
  formats: ["founder talking head over an icon grid"],
  type: ["cream background, serif headline, one italic accent word"],
  colours: ["forest green with cream cards"],
  new: ["more creator skits than last week"],
};

test("well-shaped notes in their own words pass", () => {
  const out = check(good, ads);
  assert.equal(out.status, 0, out.stderr);
});

test("notes that carry five words in a row from an ad are refused", () => {
  const out = check({ ...good, new: ["they say every top model in one plan now"] }, ads);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /carry an ad's words/u);
});

test("notes of another shape, a wrong feature or overlong text are refused", () => {
  for (const notes of [
    { ...good, quotes: ["x"] },
    { ...good, devices: good.devices.slice(0, 2) },
    { ...good, devices: [...good.devices.slice(1), { ...device("x"), borrowFor: "pricing" }] },
    { ...good, type: ["x".repeat(161)] },
    "not json",
  ]) {
    const out = check(notes, ads);
    assert.equal(out.status, 1, JSON.stringify(notes).slice(0, 80));
  }
});
