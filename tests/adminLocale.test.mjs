import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ADMIN_LOCALES,
  adminMessagesFor,
  resolveAdminLocale,
} from "../lib/adminLocale.ts";
import {
  ADMIN_DETAIL_ROUTES,
  ADMIN_NAVIGATION,
  ADMIN_NAV_GROUPS,
  ADMIN_UNLISTED_PAGES,
} from "../lib/adminNavigation.ts";
import {
  ADMIN_DETAIL_ROUTES_KO,
  ADMIN_NAV_GROUP_LABELS_KO,
  ADMIN_NAV_ITEMS_KO,
  ADMIN_UNLISTED_PAGES_KO,
  localizeAdminPageMeta,
  localizedAdminSearchablePages,
  matchLocalizedAdminPages,
} from "../lib/adminNavigationLocale.ts";

test("the console speaks exactly English and Korean", () => {
  assert.deepEqual([...ADMIN_LOCALES], ["en", "ko"]);
});

test("an explicit console choice wins over every other signal", () => {
  assert.equal(
    resolveAdminLocale({
      adminCookie: "ko",
      productCookie: "en",
      documentLanguage: "en",
      documentLanguageSource: "search",
    }),
    "ko"
  );
  assert.equal(
    resolveAdminLocale({ adminCookie: "en", documentLanguage: "ko" }),
    "en"
  );
});

test("a pinned ?lang= outranks the product cookie but not the console cookie", () => {
  assert.equal(
    resolveAdminLocale({
      productCookie: "en",
      documentLanguage: "ko",
      documentLanguageSource: "search",
    }),
    "ko"
  );
});

test("the product cookie outranks the browser's Accept-Language", () => {
  assert.equal(
    resolveAdminLocale({
      productCookie: "en",
      documentLanguage: "ko",
      documentLanguageSource: "accept",
    }),
    "en"
  );
  assert.equal(
    resolveAdminLocale({
      productCookie: "ko",
      documentLanguage: "en",
      documentLanguageSource: "accept",
    }),
    "ko"
  );
});

test("a product language the console has no copy for reads English", () => {
  for (const language of ["fr", "de", "es", "pt", "zh"]) {
    assert.equal(resolveAdminLocale({ productCookie: language }), "en");
    assert.equal(
      resolveAdminLocale({ documentLanguage: language, documentLanguageSource: "accept" }),
      "en"
    );
  }
});

test("a malformed cookie falls through instead of forcing English", () => {
  assert.equal(
    resolveAdminLocale({
      adminCookie: "kr",
      productCookie: "nonsense",
      documentLanguage: "ko",
      documentLanguageSource: "accept",
    }),
    "ko"
  );
  assert.equal(resolveAdminLocale({}), "en");
});

test("every navigation entry, tab, group and page has Korean copy", () => {
  for (const group of ADMIN_NAV_GROUPS) {
    assert.ok(ADMIN_NAV_GROUP_LABELS_KO[group], `group ${group}`);
  }
  for (const item of ADMIN_NAVIGATION) {
    const ko = ADMIN_NAV_ITEMS_KO[item.id];
    assert.ok(ko?.label && ko.description, `entry ${item.id}`);
    for (const tab of item.tabs || []) {
      const koTab = ko.tabs?.[tab.id];
      assert.ok(koTab?.label && koTab.description, `tab ${item.id}/${tab.id}`);
    }
    // A Korean tab with no English counterpart is a renamed or deleted tab.
    for (const tabId of Object.keys(ko.tabs || {})) {
      assert.ok(
        (item.tabs || []).some((tab) => tab.id === tabId),
        `stale Korean tab ${item.id}/${tabId}`
      );
    }
  }
  assert.deepEqual(
    Object.keys(ADMIN_NAV_ITEMS_KO).sort(),
    ADMIN_NAVIGATION.map((item) => item.id).sort(),
    "Korean entries and route table entries differ"
  );
  for (const route of ADMIN_DETAIL_ROUTES) {
    assert.ok(ADMIN_DETAIL_ROUTES_KO[route.id]?.label, `detail ${route.id}`);
  }
  for (const page of ADMIN_UNLISTED_PAGES) {
    assert.ok(ADMIN_UNLISTED_PAGES_KO[page.id]?.label, `unlisted ${page.id}`);
  }
});

test("page meta is translated without moving the route", () => {
  const en = localizeAdminPageMeta("/admin/users/abc", "en");
  const ko = localizeAdminPageMeta("/admin/users/abc", "ko");
  assert.equal(en.label, "Customer detail");
  assert.equal(ko.label, "고객 상세");
  assert.equal(ko.parentLabel, "사용자");
  assert.equal(ko.href, en.href);
  assert.equal(ko.parentHref, en.parentHref);
  assert.equal(localizeAdminPageMeta("/admin/refunds", "ko").label, "환불");
  assert.equal(localizeAdminPageMeta("/admin/search", "ko").label, "전체 검색");
  assert.equal(localizeAdminPageMeta("/admin/nowhere", "ko").isKnown, false);
});

test("the palette finds a page by either language in either console", () => {
  for (const locale of ADMIN_LOCALES) {
    const pages = localizedAdminSearchablePages(locale);
    assert.ok(
      matchLocalizedAdminPages("환불", pages).some((page) => page.id === "refunds"),
      `${locale}: Korean query`
    );
    assert.ok(
      matchLocalizedAdminPages("refund", pages).some((page) => page.id === "refunds"),
      `${locale}: English query`
    );
  }
  const koRefunds = localizedAdminSearchablePages("ko").find((page) => page.id === "refunds");
  assert.equal(koRefunds.label, "환불");
  assert.equal(koRefunds.href, "/admin/refunds");
});

/**
 * Components that render no operator-visible copy of their own. Anything else
 * under components/admin/ must read a message catalog, so a new panel written
 * with English literals fails here instead of shipping an English island in the
 * Korean console.
 */
const COMPONENTS_WITHOUT_COPY = new Set([
  "AdminConsolePreferences.tsx",
  "AdminLocaleProvider.tsx",
]);

test("every admin component reads its copy from a message catalog", () => {
  const directory = join(process.cwd(), "components", "admin");
  const missing = readdirSync(directory)
    .filter((name) => name.endsWith(".tsx") && !COMPONENTS_WITHOUT_COPY.has(name))
    .filter(
      (name) =>
        !readFileSync(join(directory, name), "utf8").includes("@/lib/adminMessages/")
    );
  assert.deepEqual(missing, [], "components with no message catalog");
});

test("the console root re-resolves its typeface for its own language", () => {
  const provider = readFileSync(
    join(process.cwd(), "components", "admin", "AdminLocaleProvider.tsx"),
    "utf8"
  );
  assert.match(provider, /lang=\{locale\}\s+data-locale-root/);
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  assert.match(css, /\[data-locale-root\]:lang\(en\)\s*\{[^}]*--font-ui:/);
  assert.match(css, /\[data-locale-root\]\s*\{\s*font-family:\s*var\(--font-ui\);/);
});

/**
 * TypeScript already rejects a Korean dictionary whose shape differs from the
 * English one. This is the runtime half: no empty strings, and formatters that
 * actually return text, in every namespace that exists.
 */
const assertSameShape = (en, ko, path) => {
  assert.deepEqual(
    Object.keys(ko).sort(),
    Object.keys(en).sort(),
    `${path}: keys differ`
  );
  for (const key of Object.keys(en)) {
    const here = `${path}.${key}`;
    if (typeof en[key] === "string") {
      assert.equal(typeof ko[key], "string", here);
      assert.ok(ko[key].trim().length > 0, `${here} is empty`);
    } else if (typeof en[key] === "function") {
      assert.equal(typeof ko[key], "function", here);
      assert.equal(ko[key].length, en[key].length, `${here} arity`);
      // Call both with the same placeholder arguments. A formatter whose
      // parameters are objects may throw on a placeholder; that says nothing
      // about its copy, so only a formatter that returns is judged.
      const sample = Array.from({ length: en[key].length }, () => 2);
      let enOut;
      let koOut;
      try {
        enOut = en[key](...sample);
        koOut = ko[key](...sample);
      } catch {
        continue;
      }
      if (typeof enOut === "string" && enOut.trim().length > 0) {
        assert.equal(typeof koOut, "string", `${here} returns no string`);
        assert.ok(koOut.trim().length > 0, `${here} returns empty text`);
      }
    } else if (en[key] && typeof en[key] === "object") {
      assertSameShape(en[key], ko[key], here);
    }
  }
};

test("every console message namespace is complete in Korean", async () => {
  const directory = join(process.cwd(), "lib", "adminMessages");
  const files = readdirSync(directory).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const module = await import(pathToFileURL(join(directory, file)).href);
    const catalogs = Object.entries(module).filter(
      ([, value]) => value && typeof value === "object" && "en" in value && "ko" in value
    );
    assert.ok(catalogs.length > 0, `${file} exports no catalog`);
    for (const [name, catalog] of catalogs) {
      assertSameShape(catalog.en, catalog.ko, `${file}:${name}`);
      assert.equal(adminMessagesFor(catalog, "ko"), catalog.ko);
      assert.equal(adminMessagesFor(catalog, "en"), catalog.en);
    }
  }
});
