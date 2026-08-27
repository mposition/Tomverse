#!/usr/bin/env node
/**
 * A locator built from product copy that matches nothing is not always a
 * failure. Which it is depends entirely on what the result is used for.
 *
 *   await expect(page.getByText("old name")).toHaveCount(0);
 *
 * is a *deliberate* dead string -- the assertion passes because the copy is
 * gone, which is the point. And a positive assertion on dead copy fails
 * loudly, names the string, and gets fixed the same day.
 *
 *   if (await page.getByRole("dialog", { name: "Old Brand" }).isVisible())
 *     return;
 *
 * is neither. `isVisible()` and `count()` resolve instead of retrying, so a
 * locator that matches nothing quietly answers "no" and the branch is never
 * taken. Nothing fails at the line that is wrong; something else fails much
 * later, somewhere else, or -- worse -- passes.
 *
 * That is not hypothetical. `openSidebarOnMobile` guarded "is the drawer
 * already open?" on a dialog named "Tomverse Review". The brand layer cutover
 * renamed `sidebar.title` to "Tomverse"; the guard stopped matching, the
 * helper clicked the header button through the open drawer's scrim, and two
 * mobile specs timed out on every commit to main for ten runs. The app
 * service waits on that check suite, so production deploys stopped with it.
 *
 * So this check is narrow on purpose: a literal is only reported when it
 * steers control flow *and* exists nowhere any rendered string could come
 * from. Assertions are left alone. A gate that cried wolf about all 400-odd
 * copy selectors in this suite would be turned off within a week.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const SPEC_DIRS = ["tests/e2e", "tests/e2e-admin"];
/** Everywhere a string the browser renders can be written. */
const SOURCE_DIRS = ["locales", "components", "app", "lib"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "test-results"]);

const walk = (dir, out = []) => {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if ([".ts", ".tsx", ".mjs", ".js"].includes(extname(path))) out.push(path);
  }
  return out;
};

/** `getByRole("button", { name: "..." })`, `getByText("...")`, `getByLabel("...")`. */
const LOCATOR_LITERAL =
  /getBy(?:Role|Text|Label|Placeholder|AltText|Title)\(\s*(?:"[^"]*"\s*,\s*\{[^}]*?name:\s*)?"([^"]{3,})"/g;

/**
 * Resolving calls. `expect(...)` retries and fails; these return a value the
 * spec then branches on.
 */
const RESOLVING = /\.(?:isVisible|isHidden|isEnabled|isDisabled|isChecked|count|textContent|innerText)\(\)/;

/**
 * Prose, as opposed to a test id, a URL, a CSS selector or a tag. Only prose
 * can go stale when product copy is rewritten.
 */
const isProse = (value) =>
  !/^[a-z][a-z0-9-]*$/.test(value) &&
  !value.startsWith("/") &&
  !value.startsWith(".") &&
  !value.startsWith("#") &&
  !value.startsWith("@") &&
  !/^https?:/.test(value) &&
  // Composed at runtime from a label and a number ("Approved 2", "Auto 3m").
  !/\d/.test(value);

const sourceText = SOURCE_DIRS.flatMap((dir) => walk(dir))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

const specFiles = SPEC_DIRS.flatMap((dir) => walk(dir));
const specText = specFiles.map((file) => readFileSync(file, "utf8"));

/**
 * A spec often puts a string on the page itself -- a mocked answer, a draft it
 * types, a seeded title -- and then locates it. Such a string is *supposed* to
 * be absent from `locales/`, so it is only stale copy if the suite does not
 * produce it either. "Produces it" means naming it somewhere other than inside
 * a locator call.
 */
const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const authoredBySuite = (literal) => {
  const escaped = escapeForRegExp(literal);
  const anywhere = new RegExp(escaped, "g");
  const inLocator = new RegExp(
    `getBy(?:Role|Text|Label|Placeholder|AltText|Title)\\([^)]*?${escaped}`,
    "g"
  );
  return specText.some((text) => {
    const total = (text.match(anywhere) || []).length;
    const inSelectors = (text.match(inLocator) || []).length;
    return total > inSelectors;
  });
};

const isStaleCopy = (literal) =>
  isProse(literal) && !sourceText.includes(literal) && !authoredBySuite(literal);

const findings = [];

specFiles.forEach((file, fileIndex) => {
  const src = specText[fileIndex];
  const lineOf = (index) => src.slice(0, index).split("\n").length;

  // Locators bound to a name, so a branch three lines later can be traced
  // back to the copy it actually depends on.
  const bound = new Map();
  const binding = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*?getBy(?:Role|Text|Label|Placeholder|AltText|Title)\([^;]*?);/gs;
  for (const match of src.matchAll(binding)) {
    LOCATOR_LITERAL.lastIndex = 0;
    const literals = [...match[2].matchAll(LOCATOR_LITERAL)].map((m) => m[1]);
    const dead = literals.filter(isStaleCopy);
    if (dead.length) bound.set(match[1], { dead, line: lineOf(match.index) });
  }

  src.split("\n").forEach((line, i) => {
    if (!RESOLVING.test(line)) return;
    // `expect(...)` is an assertion: it retries, and it fails out loud.
    if (/\bexpect\s*\(/.test(line)) return;

    // Inline: the literal is on this very line.
    LOCATOR_LITERAL.lastIndex = 0;
    const inline = [...line.matchAll(LOCATOR_LITERAL)]
      .map((m) => m[1])
      .filter(isStaleCopy);

    // Bound: the line branches on a variable that holds dead copy.
    const viaBinding = [...bound.entries()]
      .filter(([name]) => new RegExp(`\\b${name}\\b`).test(line))
      .flatMap(([, info]) => info.dead);

    const dead = [...new Set([...inline, ...viaBinding])];
    if (dead.length) {
      findings.push({ file, line: i + 1, dead, source: line.trim() });
    }
  });
});

if (findings.length === 0) {
  console.log("check:e2e-copy-selectors — no branch-steering locator depends on copy that no longer exists.");
  process.exit(0);
}

console.error(
  `check:e2e-copy-selectors — ${findings.length} branch(es) steer on product copy that exists nowhere in ${SOURCE_DIRS.join(", ")}.\n` +
    "Such a branch is never taken and never fails; it silently does nothing.\n"
);
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}`);
  console.error(`      copy not found: ${finding.dead.map((d) => JSON.stringify(d)).join(", ")}`);
  console.error(`      ${finding.source}`);
}
console.error(
  "\nEither the copy moved -- update the locator, or key it on a data-testid that\n" +
    "a rename cannot break -- or the branch is dead and should be deleted."
);
process.exit(1);
