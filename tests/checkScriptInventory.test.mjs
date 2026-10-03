// The check-script inventory (scripts/check-script-inventory-core.mjs).
//
// The inventory is a declared list, so it can be wrong in exactly the ways a
// list goes wrong: a script gets renamed and the entry points at nothing, or a
// tool gains a default and quietly becomes a gate that this file still excuses.
// These tests are the part the list cannot do for itself -- they ask the tree
// whether it still agrees.

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
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

/**
 * Runs a `check:*` command with nothing supplied, and returns how it refused.
 *
 * Grepping the source for "is required" was the first version of this and it
 * proved nothing: the usage *comment* at the top of each file matched, so a
 * script that gained a default or lost its refusal branch would still have
 * passed. The exit code is the only thing a comment cannot fake.
 *
 * `without` names environment variables to remove, because a machine that
 * happens to hold the credential would otherwise watch the check run for real
 * -- which is exactly the mistake that produced the first, wrong inventory.
 */
const refusalOf = (script, without = []) => {
  const env = { ...process.env };
  for (const key of without) delete env[key];
  const result = spawnSync(process.execPath, ["--run", script], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
};

/** Escapes a literal for use inside a RegExp. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The part of a requirement the refusal has to name.
 *
 * A flag keeps its name and drops its placeholder (`--artifact=<path>` ->
 * `--artifact`). A positional argument *is* its placeholder, so `<origin>`
 * stays whole -- stripping from the first `<` left an empty needle, and an
 * empty needle matches everything, so that assertion passed no matter what the
 * tool printed.
 */
const mentionedIn = (flag) => (flag.startsWith("-") ? flag.replace(/[=<].*$/, "") : flag);

for (const entry of ARGUMENT_REQUIRED_CHECKS) {
  test(`${entry.script} refuses with no argument`, () => {
    const { status, output } = refusalOf(entry.script);
    assert.notEqual(
      status,
      0,
      "a tool that now succeeds with no argument has become a gate -- take it " +
        "out of the inventory rather than leaving it excused here."
    );
    // The requirement's own name too: a non-zero exit that no longer says what
    // it wants is not a usable tool, whatever the inventory claims about it.
    const needle = mentionedIn(entry.flag);
    assert.ok(needle.length > 0, `${entry.script}: empty needle would match anything`);
    assert.match(output, new RegExp(literal(needle)));
  });
}

for (const entry of ENVIRONMENT_REQUIRED_CHECKS) {
  const variable = entry.requires.split("=")[0];
  test(`${entry.script} refuses without ${variable}`, () => {
    // Each of these refuses before it calls out or writes anything, which is
    // what makes spawning them here safe: no request, no mail, no spend.
    const { status, output } = refusalOf(entry.script, [variable]);
    assert.notEqual(status, 0, `${entry.script} should fail closed without ${variable}`);
    assert.match(output, new RegExp(literal(variable)));
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
