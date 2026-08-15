import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveThemePreference,
  themeDocumentClass,
  themeCookieValue,
  THEME_COOKIE_NAME,
} from "../lib/theme.ts";

// UI-001. `dark:` now resolves from two places -- an explicit `.dark` class and
// `prefers-color-scheme` where no explicit choice exists -- and the dark token
// block is written twice to serve both. Duplication that nothing checks is
// duplication that drifts, so these tests read the stylesheets and fail when
// the two copies stop agreeing.
//
// The token blocks live in @tomverse/ui-tokens because every client needs the
// same values; the `dark:` variant that reads them is a Tailwind directive and
// stays in the app. So this file reads two stylesheets, and each assertion
// names the one it is about.

const tokensCss = readFileSync(
  join(process.cwd(), "packages", "ui-tokens", "src", "tokens.css"),
  "utf8"
);
const appCss = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

/** Declarations inside the first `{ ... }` that follows `selector`. */
const declarationsAfter = (selector, css = tokensCss, sourceName = "packages/ui-tokens/src/tokens.css") => {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `${sourceName} no longer contains ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  assert.ok(open !== -1 && close !== -1, `${selector} has no rule body`);
  return css
    .slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [property, ...rest] = line.split(":");
      return [property.trim(), rest.join(":").trim()];
    })
    .sort(([a], [b]) => a.localeCompare(b));
};

test("the explicit-dark and system-dark token blocks declare the same thing", () => {
  const explicit = declarationsAfter(":root.dark {");
  const system = declarationsAfter(":root:not(.light):not(.dark) {");

  assert.ok(explicit.length > 0, "the explicit dark block is empty");
  assert.deepStrictEqual(
    system,
    explicit,
    "packages/ui-tokens/src/tokens.css: `:root.dark` and the " +
      "`prefers-color-scheme: dark` block " +
      "must declare identical properties and values. A token added to one and " +
      "not the other means a visitor on OS dark with no explicit choice sees a " +
      "different palette from one who picked dark."
  );
});

test("the system-dark block is inside a prefers-color-scheme media query", () => {
  const index = tokensCss.indexOf(":root:not(.light):not(.dark) {");
  assert.notEqual(index, -1);
  const preceding = tokensCss.slice(0, index);
  const lastMediaQuery = preceding.lastIndexOf("@media");
  assert.notEqual(lastMediaQuery, -1, "no media query precedes the block");
  assert.match(
    tokensCss.slice(lastMediaQuery, index),
    /prefers-color-scheme:\s*dark/,
    "the system-dark token block must be gated on prefers-color-scheme: dark"
  );
});

test("the app imports the token package rather than restating it", () => {
  assert.match(
    appCss,
    /@import\s+"@tomverse\/ui-tokens\/tokens\.css"/,
    "app/globals.css must import the shared tokens; without the import the " +
      "blocks this file checks are not on the page at all"
  );
  // A second definition would win or lose by import order, and the tests above
  // would still pass while the page showed something else.
  for (const token of ["--background", "--tomverse-accent-start"]) {
    assert.ok(
      !new RegExp(`^\\s*${token}\\s*:`, "m").test(appCss),
      `app/globals.css redefines ${token}; it belongs to @tomverse/ui-tokens`
    );
  }
});

test("the dark variant covers an explicit class and an unset preference", () => {
  const variantStart = appCss.indexOf("@custom-variant dark");
  assert.notEqual(variantStart, -1, "the dark custom variant is gone");
  const variant = appCss.slice(
    variantStart,
    appCss.indexOf("\n}", variantStart)
  );

  // An explicit choice.
  assert.match(variant, /\.dark/, "the variant no longer matches `.dark`");
  // The OS preference, but only where no explicit choice overrides it. Without
  // the `:not(.light)` half, a visitor who chose light on a dark OS would be
  // overridden by their system setting.
  assert.match(variant, /prefers-color-scheme:\s*dark/);
  assert.match(variant, /:not\(\.light\)/);
  assert.match(variant, /:not\(\.dark\)/);
});

test("an explicit choice wins over the stored migration value and the default", () => {
  assert.equal(resolveThemePreference({ cookie: "light", stored: "dark" }), "light");
  assert.equal(resolveThemePreference({ cookie: "dark", stored: "light" }), "dark");
  assert.equal(resolveThemePreference({ cookie: "system", stored: "dark" }), "system");
});

test("the pre-cookie localStorage value is the migration source, not the authority", () => {
  assert.equal(resolveThemePreference({ cookie: null, stored: "dark" }), "dark");
  assert.equal(resolveThemePreference({ stored: "light" }), "light");
});

test("no stored choice anywhere resolves to system", () => {
  assert.equal(resolveThemePreference({}), "system");
  assert.equal(resolveThemePreference({ cookie: null, stored: null }), "system");
  // A tampered or stale value is not a choice.
  assert.equal(resolveThemePreference({ cookie: "sepia", stored: "" }), "system");
  assert.equal(resolveThemePreference({ cookie: "DARK" }), "system");
});

test("system carries neither class, so the media query decides", () => {
  assert.equal(themeDocumentClass("dark"), "dark");
  assert.equal(themeDocumentClass("light"), "light");
  assert.equal(
    themeDocumentClass("system"),
    "",
    "`system` must not write a class, or the stylesheet cannot tell it apart " +
      "from an explicit choice"
  );
});

test("the theme cookie is readable before hydration and survives an external link", () => {
  const cookie = themeCookieValue("dark");
  assert.match(cookie, new RegExp(`^${THEME_COOKIE_NAME}=dark;`));
  assert.match(cookie, /Path=\//);
  // Lax, not Strict: the first paint after arriving from an external link is
  // exactly the visit Strict would strip the cookie from.
  assert.match(cookie, /SameSite=Lax/);
  // Not HttpOnly: the pre-paint bootstrap has to read it from document.cookie.
  assert.doesNotMatch(cookie, /HttpOnly/i);
});
