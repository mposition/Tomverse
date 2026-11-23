import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { projectWorkspaceCopy } from "../locales/projectWorkspace.ts";

const languages = ["en", "ko", "zh", "zh-Hant", "fr", "de", "es", "pt"];
const placeholders = (text) => (text.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(",");
const lookup = (object, dotted) => dotted.split(".").reduce((value, key) => value?.[key], object);

function leaves(object, prefix = "") {
  return Object.entries(object).flatMap(([key, value]) =>
    typeof value === "string" ? [[`${prefix}${key}`, value]] : leaves(value, `${prefix}${key}.`));
}

test("every language carries every project workspace string with the same placeholders", () => {
  assert.deepEqual(Object.keys(projectWorkspaceCopy).sort(), [...languages].sort());
  for (const [key, english] of leaves(projectWorkspaceCopy.en)) {
    for (const language of languages) {
      const value = lookup(projectWorkspaceCopy[language], key);
      assert.equal(typeof value, "string", `${language} is missing ${key}`);
      assert.ok(value.length > 0, `${language} ${key} is empty`);
      assert.equal(placeholders(value), placeholders(english), `${language} ${key} placeholders differ`);
    }
  }
});

test("every projectWorkspace key the UI asks for exists", () => {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk("components/projects");
  files.push("components/chat/ChatSidebar.tsx", "components/chat/ChatMessageList.tsx", "lib/projectWorkspaceUi.ts");
  const used = new Set();
  for (const file of files) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(/"projectWorkspace\.([A-Za-z0-9_.]+)"/g)) used.add(match[1]);
  }
  assert.ok(used.size > 100);
  for (const key of used) assert.equal(typeof lookup(projectWorkspaceCopy.en, key), "string", `missing copy for projectWorkspace.${key}`);
  // Keys built at runtime.
  for (const key of ["conversations.effect.gains_context", "conversations.effect.loses_context", "conversations.effect.switches_context",
    "conversations.effect.folder_only", "search.kind.message", "search.kind.imported", "search.kind.material", "receipt.via.context", "receipt.via.tool",
    "tabs.overview", "tabs.settings"]) assert.equal(typeof lookup(projectWorkspaceCopy.en, key), "string", key);
});

test("the receipt copy never claims the model used a delivered source", () => {
  for (const language of languages) {
    assert.ok(projectWorkspaceCopy[language].receipt.caveat.length > 20);
  }
  assert.match(projectWorkspaceCopy.en.receipt.caveat, /do not prove/i);
});
