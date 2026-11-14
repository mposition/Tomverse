import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Guards the one shape of `overrides` entry that npm refuses outright.
 *
 * `@npmcli/arborist`'s `assertRootOverrides` throws `EOVERRIDE` ("Override for
 * <name>@<spec> conflicts with direct dependency") when an override changes
 * the version of a package the root also depends on directly, unless the
 * override is written as the `$<name>` reference. A literal spec that happens
 * to equal the dependency's spec installs cleanly today and breaks the moment
 * either side moves -- which is exactly what Dependabot does. It bumped
 * `pdfjs-dist` past the literal `"^6.2.108"` override and every update job on
 * the repository failed, not just that one dependency's.
 *
 * `$<name>` cannot drift: it means "whatever the root asks for", so one edit
 * to `dependencies` keeps the override in step. These assertions therefore
 * reject the literal form even when it currently agrees, and the probes below
 * run the same rule over hand-written input so a passing suite keeps meaning
 * the rule still applies.
 */

const ROOT = process.cwd();

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];

const packageJson = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
);

/**
 * The spec an override imposes on the overridden package itself. A string is
 * that spec; an object constrains the package's own dependencies and only
 * touches its version through the `"."` key, which npm reads the same way.
 */
const ownSpec = (rule) => {
  if (typeof rule === "string") return rule;
  if (rule && typeof rule === "object" && typeof rule["."] === "string") {
    return rule["."];
  }
  return null;
};

/**
 * Names whose root override would reach `assertRootOverrides`, with the spec
 * each side asks for. Only top-level keys matter: a nested rule applies to a
 * transitive edge, which npm is happy to rewrite.
 */
const rootOverrideConflicts = (manifest) => {
  const direct = new Map();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (!direct.has(name)) direct.set(name, spec);
    }
  }

  const conflicts = [];
  for (const [name, rule] of Object.entries(manifest.overrides ?? {})) {
    if (!direct.has(name)) continue;
    const spec = ownSpec(rule);
    if (spec === null || spec === `$${name}`) continue;
    conflicts.push({ name, override: spec, dependency: direct.get(name) });
  }
  return conflicts;
};

test("root overrides of direct dependencies use the $name reference", () => {
  const conflicts = rootOverrideConflicts(packageJson);
  assert.deepEqual(
    conflicts,
    [],
    `overrides of a direct dependency must be written as "$<name>", not a ` +
      `literal spec that Dependabot can push out of step: ${conflicts
        .map((c) => `${c.name} (override ${c.override}, dependency ${c.dependency})`)
        .join(", ")}`,
  );
});

test("pdfjs-dist is still overridden, by reference", () => {
  // officeparser pins pdfjs-dist exactly, so dropping the override would give
  // the tree a second copy of a package that ships its own worker build.
  assert.equal(packageJson.overrides["pdfjs-dist"], "$pdfjs-dist");
  assert.equal(typeof packageJson.dependencies["pdfjs-dist"], "string");
});

test("the rule flags a literal override of a direct dependency", () => {
  const drifted = rootOverrideConflicts({
    dependencies: { "pdfjs-dist": "^6.5.438" },
    overrides: { "pdfjs-dist": "^6.2.108" },
  });
  assert.deepEqual(drifted, [
    { name: "pdfjs-dist", override: "^6.2.108", dependency: "^6.5.438" },
  ]);

  // The form the repository shipped before this test existed: agreeing specs,
  // which npm accepts and the next version bump turns into EOVERRIDE.
  const agreeing = rootOverrideConflicts({
    dependencies: { "pdfjs-dist": "^6.2.108" },
    overrides: { "pdfjs-dist": "^6.2.108" },
  });
  assert.equal(agreeing.length, 1);

  // A `"."` key is the same claim about the package's own version.
  const dotted = rootOverrideConflicts({
    devDependencies: { postcss: "^8.5.25" },
    overrides: { postcss: { ".": "8.5.25", nanoid: "^3.3.17" } },
  });
  assert.deepEqual(dotted, [
    { name: "postcss", override: "8.5.25", dependency: "^8.5.25" },
  ]);
});

test("the rule leaves alone what npm accepts", () => {
  // Reference form, a nested rule with no `"."`, and an override of a package
  // that is only a transitive dependency.
  assert.deepEqual(
    rootOverrideConflicts({
      dependencies: { sharp: "^0.35.5", postcss: "^8.5.25" },
      overrides: {
        sharp: "$sharp",
        postcss: { nanoid: "^3.3.17" },
        "fast-uri": "^3.1.6",
      },
    }),
    [],
  );
});
