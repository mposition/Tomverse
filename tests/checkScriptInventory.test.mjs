// The check-script inventory (scripts/check-script-inventory-core.mjs).
//
// The inventory is a declared list, so it can be wrong in exactly the ways a
// list goes wrong: a script gets renamed and the entry points at nothing, or a
// tool gains a default and quietly becomes a gate that this file still excuses.
// These tests are the part the list cannot do for itself -- they ask the tree
// whether it still agrees.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARGUMENT_REQUIRED_CHECKS,
  ENVIRONMENT_REQUIRED_CHECKS,
  classifiedScripts,
  classifyCheckScript,
  describeInventory,
} from "../scripts/check-script-inventory-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const checkScripts = Object.keys(manifest.scripts ?? {}).filter((name) =>
  name.startsWith("check:")
);

/** The .mjs file a `check:*` command runs, read as text. */
const sourceOf = (script) => {
  const command = manifest.scripts[script];
  const file = command.match(/(scripts\/[\w.-]+\.mjs)/)?.[1];
  assert.ok(file, `${script} runs a scripts/*.mjs file`);
  return readFileSync(join(root, file), "utf8");
};

test("every classified script is still a declared check script", () => {
  for (const script of classifiedScripts()) {
    assert.ok(
      checkScripts.includes(script),
      `${script} is in the inventory but not in package.json -- renamed, or the ` +
        "entry is stale. Either way the inventory is now excusing nothing."
    );
  }
});

test("no script is classified twice", () => {
  const seen = classifiedScripts();
  assert.equal(new Set(seen).size, seen.length);
});

test("every entry states a reason", () => {
  for (const entry of [...ARGUMENT_REQUIRED_CHECKS, ...ENVIRONMENT_REQUIRED_CHECKS]) {
    assert.ok(
      typeof entry.reason === "string" && entry.reason.length > 20,
      `${entry.script} says why it cannot just run`
    );
  }
});

for (const entry of ARGUMENT_REQUIRED_CHECKS) {
  test(`${entry.script} still refuses without its argument`, () => {
    const source = sourceOf(entry.script);
    // The refusal, not the exit code: all five print what they need, and a
    // tool that stopped printing it would be a worse tool even if it still
    // exited non-zero.
    assert.match(
      source,
      /is required|Usage:/,
      "a tool that no longer says what it needs has become something else -- " +
        "if it gained a default it is a gate now, so take it out of the inventory."
    );
  });
}

for (const entry of ENVIRONMENT_REQUIRED_CHECKS) {
  test(`${entry.script} still names what it needs from the environment`, () => {
    const variable = entry.requires.split("=")[0];
    assert.match(
      sourceOf(entry.script),
      new RegExp(variable),
      `${entry.script} should still read ${variable}`
    );
  });
}

test("an ordinary check is a gate", () => {
  assert.equal(classifyCheckScript("check:accent-tokens"), "gate");
  assert.equal(classifyCheckScript("check:retired-product-name"), "gate");
});

test("the classification matches the list it came from", () => {
  assert.equal(classifyCheckScript("check:edge-robots"), "argument_required");
  assert.equal(classifyCheckScript("check:fal-image-pricing"), "environment_required");
});

test("the report says it is a report", () => {
  const text = describeInventory(checkScripts);
  assert.match(text, /This is a report\. It fails nothing/);
  // The count is the point of the whole file: it is what someone enumerating
  // the scripts gets wrong.
  const gates = checkScripts.length - classifiedScripts().length;
  assert.match(text, new RegExp(`${checkScripts.length} check script\\(s\\): ${gates} gate`));
});
