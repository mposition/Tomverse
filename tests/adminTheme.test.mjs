import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ADMIN_THEMES, ADMIN_THEME_COOKIE, adminThemeCookieValue, resolveAdminTheme } from "../lib/adminTheme.ts";
import { adminThemeCss } from "../scripts/generate-admin-theme-css.mjs";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");
const CSS_PATH = "app/(site)/(application)/admin/admin-theme.css";

test("the console stays dark unless Light was chosen explicitly", () => {
  assert.deepEqual([...ADMIN_THEMES], ["dark", "light"]);
  assert.equal(resolveAdminTheme(undefined), "dark");
  assert.equal(resolveAdminTheme(null), "dark");
  assert.equal(resolveAdminTheme("system"), "dark");
  assert.equal(resolveAdminTheme("LIGHT"), "dark");
  assert.equal(resolveAdminTheme("light"), "light");
  // Its own cookie: the product theme is never moved by the console.
  assert.equal(ADMIN_THEME_COOKIE, "tomverse_admin_theme");
  assert.match(adminThemeCookieValue("light"), /^tomverse_admin_theme=light; Path=\/; Max-Age=\d+; SameSite=Lax$/);
});

test("the Light stylesheet is exactly what the generator makes from Tailwind's palette", () => {
  const generated = adminThemeCss(read("node_modules/tailwindcss/theme.css"));
  assert.equal(read(CSS_PATH), generated, "run npm run generate:admin-theme-css");
});

test("Light draws the page zinc-100 and a card white, and keeps solid buttons' white text", () => {
  const theme = read("node_modules/tailwindcss/theme.css");
  const value = (name) => theme.match(new RegExp(`--color-${name}:\\s*([^;]+);`))[1].trim();
  const css = read(CSS_PATH);
  const light = css.slice(css.indexOf(':root:has([data-admin-theme="light"]) {'));
  assert.ok(light.includes(`--color-zinc-950: ${value("zinc-100")};`));
  assert.ok(light.includes(`--color-zinc-900: ${value("white")};`));
  assert.ok(light.includes(`--color-zinc-100: ${value("zinc-900")};`));
  assert.ok(light.includes(`--color-amber-950: ${value("amber-50")};`));
  assert.ok(light.includes(`--color-amber-200: ${value("amber-800")};`));
  // Solid steps are not remapped: a blue-600 button is blue-600 in both themes.
  assert.ok(light.includes(`--color-blue-600: ${value("blue-600")};`));
  assert.ok(light.includes(`--color-white: ${value("zinc-950")};`));
  assert.match(css, /\[class~="bg-blue-600"\][^{]*\{\s*--color-white: #fff;/);
});

test("the layout reads the cookie, the shell carries the theme, and the account menu changes it", () => {
  const layout = read("app/(site)/(application)/admin/layout.tsx");
  assert.ok(layout.includes('import "./admin-theme.css";'));
  assert.ok(layout.includes("resolveAdminTheme(cookieStore.get(ADMIN_THEME_COOKIE)?.value)"));
  assert.ok(layout.includes("theme={theme}"));
  const shell = read("components/admin/AdminConsoleShell.tsx");
  assert.ok(shell.includes("data-admin-theme={theme}"));
  assert.ok(shell.includes("document.cookie = adminThemeCookieValue(next);"));
  const menu = read("components/admin/AdminAccountMenu.tsx");
  assert.ok(menu.includes('role="menuitemradio"') && menu.includes("admin-account-menu-theme-"));
});

test("every Admin component and page is written in dark classes only, with no dark: pair", () => {
  // Light is a palette remap of the dark classes. A `dark:` pair follows the
  // product theme instead, so it drew light surfaces under light text whenever
  // the product and the console disagreed.
  const roots = ["components/admin", "app/(site)/(application)/admin"];
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(process.cwd(), dir))) {
      const path = `${dir}/${name}`;
      if (statSync(join(process.cwd(), path)).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) files.push(path);
    }
  };
  roots.forEach(walk);
  assert.ok(files.length > 100);
  const offenders = files.filter((path) => /(^|[\s"'`])dark:[a-z]/m.test(read(path)));
  assert.deepEqual(offenders, []);
  // A literal colour is outside the palette, so Light cannot remap it.
  const literal = files.filter((path) => /\b(?:bg|text|border|from|to|via|ring|fill|stroke)-\[(?:#|rgb|hsl|oklch)/.test(read(path)));
  assert.deepEqual(literal, []);
});
