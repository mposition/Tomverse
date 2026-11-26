import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codeMemoryEnabled, codeMemoryFile, codeMemoryFor, codeMemoryView, setCodeMemoryEnabled } from "../src/host/code-memory";
import { codeMemoryInput } from "../src/contract";

const project = { path: "/work/demo", identity: "id-1" };
const directory = () => join(mkdtempSync(join(tmpdir(), "tv-code-memory-")), "code-memory");

test("memory input takes four actions and a note id of one shape, and nothing else", () => {
  assert.deepEqual(codeMemoryInput.parse({ action: "read" }), { action: "read" });
  assert.deepEqual(codeMemoryInput.parse({ action: "remove", id: "m-0a1b2c3d" }), { action: "remove", id: "m-0a1b2c3d" });
  assert.equal(codeMemoryInput.parse({ action: "set-enabled", enabled: false }).action, "set-enabled");
  for (const input of [{ action: "remove", id: "../x" }, { action: "remove" }, { action: "set-enabled", enabled: "no" }, { action: "clear", extra: 1 }, { action: "write" }]) {
    assert.throws(() => codeMemoryInput.parse(input), JSON.stringify(input));
  }
});

test("memory is on until the person turns it off, and off hands a task no memory at all", () => {
  const dir = directory();
  assert.equal(codeMemoryEnabled(dir), true);
  const memory = codeMemoryFor(dir, project, (text) => text);
  assert.ok(memory);
  assert.equal(memory.add("Run npm run lint.").status, "saved");
  assert.equal(codeMemoryView(dir, project).entries.length, 1);
  assert.deepEqual(codeMemoryView(dir, project, { action: "set-enabled", enabled: false }), { enabled: false, project: true, entries: codeMemoryView(dir, project).entries });
  assert.equal(codeMemoryFor(dir, project, (text) => text), undefined, "off: no memory object, so nothing can be read or written");
  setCodeMemoryEnabled(dir, true);
  assert.ok(codeMemoryFor(dir, project, (text) => text));
  assert.equal(codeMemoryFor(undefined, project, (text) => text), undefined, "no folder, no memory");
});

test("the settings view lists, removes and clears one project's notes and leaves another project's alone", () => {
  const dir = directory();
  const other = { path: "/work/other", identity: "id-2" };
  const mine = codeMemoryFor(dir, project, (text) => text)!;
  const theirs = codeMemoryFor(dir, other, (text) => text)!;
  mine.add("first");
  const second = mine.add("second");
  theirs.add("theirs");
  assert.notEqual(codeMemoryFile(dir, project), codeMemoryFile(dir, other));
  assert.deepEqual(codeMemoryView(dir, project).entries.map((e) => e.text), ["first", "second"]);
  const id = (second as { entry: { id: string } }).entry.id;
  assert.deepEqual(codeMemoryView(dir, project, { action: "remove", id }).entries.map((e) => e.text), ["first"]);
  assert.deepEqual(codeMemoryView(dir, project, { action: "clear" }).entries, []);
  assert.deepEqual(codeMemoryView(dir, other).entries.map((e) => e.text), ["theirs"]);
  assert.deepEqual(codeMemoryView(dir, null), { enabled: true, project: false, entries: [] });
  assert.ok(readdirSync(dir).some((name) => name.endsWith(".json")));
});

test("a note that holds the account key is refused by the task's own redaction", () => {
  const dir = directory();
  const key = "tvk_abcdefgh_0123456789abcdef";
  const memory = codeMemoryFor(dir, project, (text) => text.replaceAll(key, "[credential removed]"))!;
  assert.equal(memory.add(`The key is ${key}`).status, "rejected");
  assert.deepEqual(codeMemoryView(dir, project).entries, []);
});
