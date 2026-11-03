import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";

// A one-segment path with no page of its own falls through to `app/[locale]`,
// which only prerenders locales (`dynamicParams = false`). A document request
// gets the 404 page, but a client-side `<Link>` navigation sends an RSC request,
// finds the cached 404 HTML and Next throws "Invariant: Expected RSC response,
// got text/html" -- a 500 on every click. That is how the Review rail's
// `href="/help"` failed in production on 2026-11-03.

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
    return [path];
  });

const siteTopLevelSegments = () => {
  const segments = new Set();
  for (const file of walk(join(root, "app", "(site)"))) {
    if (!/[\\/](page|route)\.(tsx|ts)$/.test(file)) continue;
    const parts = relative(join(root, "app", "(site)"), file)
      .split(sep)
      .slice(0, -1)
      .filter((part) => !/^\(.*\)$/.test(part));
    if (parts.length) segments.add(parts[0]);
  }
  return segments;
};

const singleSegmentHrefs = () => {
  const found = [];
  const pattern = /href=\{?["`]\/([a-z0-9-]+)(?:[?#][^"`]*)?["`]/g;
  for (const dir of ["app", "components"]) {
    for (const file of walk(join(root, dir))) {
      if (!/\.(tsx|ts)$/.test(file)) continue;
      for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
        found.push({ file: relative(root, file), segment: match[1] });
      }
    }
  }
  return found;
};

test("every literal one-segment href has a page outside app/[locale]", () => {
  const segments = siteTopLevelSegments();
  const hrefs = singleSegmentHrefs();
  assert.ok(hrefs.length > 10, "the scan should find the app's literal links");
  const missing = hrefs.filter(({ segment }) => !segments.has(segment));
  assert.deepEqual(missing, []);
});

test("the Review rail help link goes to the help centre", () => {
  const source = readFileSync(
    join(root, "components", "chat", "ReviewStudioChrome.tsx"),
    "utf8"
  );
  assert.match(source, /href=\{helpCentreHref\(lang\)\} data-testid="navigation-help"/);
  assert.doesNotMatch(source, /href="\/help"/);
});
