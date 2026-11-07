import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The research call reads competitors' ads with nothing but a Read tool; its
 * answer is written as notes for the call that writes copy only when
 * check-research-notes.mjs accepts it (owner 2026-11-07;
 * docs/policy/marketing-automation.md §2, external text is data): the agreed
 * shape, brands from research-brands.json, no run of five words from any ad.
 */

const check = (answer, ads) => {
  const dir = mkdtempSync(join(tmpdir(), "research-notes-"));
  try {
    writeFileSync(join(dir, "answer.txt"), typeof answer === "string" ? answer : `${JSON.stringify(answer)}\n{"event":"account"}\n`);
    writeFileSync(join(dir, "ads.json"), JSON.stringify(ads));
    const out = join(dir, "notes", "20261109.json");
    const run = spawnSync(process.execPath, ["tools/marketing-video/check-research-notes.mjs", join(dir, "answer.txt"), join(dir, "ads.json"), out], { encoding: "utf8" });
    return { ...run, written: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const ads = [{ brand: "runable", body: "Every top model in one plan, cancel anytime and keep your chats forever." }];
const device = (look, seenAt = ["runable"]) => ({ device: "paper receipt", look, seenAt, borrowFor: "analysis" });
const good = {
  date: "2026-11-09",
  devices: [device("a long thermal slip with ruled rows"), device("app icons in a grid", ["sauna"]), device("a ticket with a ribbon"), device("chips falling into a list")],
  formats: ["founder talking head over an icon grid"],
  type: ["cream background, serif headline, one italic accent word"],
  colours: ["forest green with cream cards"],
  new: ["more creator skits than last week"],
};

test("a well-shaped answer in its own words is written as the notes", () => {
  const out = check(good, ads);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.written, good);
});

test("five words in a row from an ad, in any field, keep the notes from being written", () => {
  for (const notes of [
    { ...good, new: ["they say every top model in one plan now"] },
    { ...good, devices: [...good.devices.slice(1), device("and keep your chats forever")] },
  ]) {
    const out = check(notes, ads);
    assert.equal(out.status, 1);
    assert.equal(out.written, null);
    // The refusal says where, never the ad's words.
    assert.doesNotMatch(out.stderr, /top model|chats forever/u);
  }
});

test("a brand that is not a research brand cannot carry words through seenAt", () => {
  const out = check({ ...good, devices: [...good.devices.slice(1), device("x", ["every top model in one plan"])] }, ads);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /seenAt/u);
  assert.equal(out.written, null);
});

test("an answer without notes, or notes of another shape, writes nothing", () => {
  for (const answer of [
    "no json here",
    { ...good, quotes: ["x"] },
    { ...good, devices: good.devices.slice(0, 2) },
    { ...good, devices: [...good.devices.slice(1), { ...device("x"), borrowFor: "pricing" }] },
    { ...good, type: ["x".repeat(161)] },
  ]) {
    const out = check(answer, ads);
    assert.equal(out.status, 1, JSON.stringify(answer).slice(0, 80));
    assert.equal(out.written, null);
  }
});
