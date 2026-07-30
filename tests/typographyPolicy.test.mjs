import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { EMAIL_FONT_STACK, EMAIL_MONO_FONT_STACK } from "../lib/emailTypography.ts";

const ROOT = process.cwd();

function collectTsx(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTsx(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const ALL_TSX = [...collectTsx(join(ROOT, "app")), ...collectTsx(join(ROOT, "components"))];
// EXT-REAUDIT-F001. These paths are compared against POSIX-shaped literals --
// the "/admin/" exclusion just below, and the `file:line` keys in
// BRAND_EXPRESSION_ALLOWLIST -- so the separator is normalized once here
// rather than at every comparison. Unnormalized, a Windows run made the admin
// console look like customer UI and missed every allowlist entry, so the suite
// failed on the platform rather than on the policy it is meant to enforce.
const rel = (file) => relative(ROOT, file).split(sep).join("/");
// The admin console inherits the same tokens but is an internal, desktop-only
// surface; the size floor below is a customer-UI guarantee.
const CUSTOMER_TSX = ALL_TSX.filter((file) => !rel(file).includes("/admin/"));

const SIZE_KEYWORD_PX = {
  "text-xs": 12,
  "text-sm": 14,
  "text-base": 16,
  "text-lg": 18,
  "text-xl": 20,
  "text-2xl": 24,
  "text-3xl": 30,
  "text-4xl": 36,
  "text-5xl": 48,
  "text-6xl": 60,
  "text-7xl": 72,
  "text-8xl": 96,
  "text-9xl": 128,
};

const SIZE_TOKEN =
  /(?:[a-z0-9-]+:)*(text-(?:xs|sm|base|lg|\d?xl|\[clamp\([^\])]*\)\]|\[\d+(?:\.\d+)?(?:px|rem)\]))/g;

// A token can carry more than one size: `text-[clamp(1.5rem,8vw,1.875rem)]`
// renders anywhere between its bounds depending on the viewport. Both bounds
// are returned so the floor test sees the smallest it can get and the weight
// test sees the largest. Viewport units are left out -- they cannot be
// resolved without a viewport, and the clamp bounds already frame them.
function tokenToPxValues(token) {
  const clamp = /^text-\[clamp\((.*)\)\]$/.exec(token);
  if (clamp) {
    return clamp[1]
      .split(",")
      .map((part) => /^\s*(\d+(?:\.\d+)?)(px|rem)\s*$/.exec(part))
      .filter(Boolean)
      .map((match) => Number(match[1]) * (match[2] === "rem" ? 16 : 1));
  }
  const bracket = /^text-\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(token);
  if (bracket) {
    return [Number(bracket[1]) * (bracket[2] === "rem" ? 16 : 1)];
  }
  const keyword = SIZE_KEYWORD_PX[token];
  return keyword === undefined ? [] : [keyword];
}

// A className is normally one string literal. Multi-line template literals are
// left open at the end of a line, so an unterminated backtick also counts as a
// segment -- otherwise a `text-[11px] font-black ${...}` button would slip past.
const CLASS_SEGMENT = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|`[^`\n]*$/g;

function* classSegments(files) {
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      for (const segment of lines[i].match(CLASS_SEGMENT) ?? []) {
        yield { file: rel(file), line: i + 1, segment };
      }
    }
  }
}

function sizesIn(segment) {
  return [...segment.matchAll(SIZE_TOKEN)].flatMap((match) => tokenToPxValues(match[1]));
}

test("customer UI never renders text below 11px", () => {
  const violations = [];
  for (const { file, line, segment } of classSegments(CUSTOMER_TSX)) {
    for (const px of sizesIn(segment)) {
      if (px < 11) violations.push(`${file}:${line} (${px}px)`);
    }
  }
  assert.deepEqual(violations, [], `Text below the 11px floor:\n${violations.join("\n")}`);
});

test("font-black is reserved for headline-sized customer text", () => {
  // Short brand expressions are the one body-size exception the weight policy
  // allows; everything else at <=16px uses 500-700.
  const BRAND_EXPRESSION_ALLOWLIST = new Set([
    "app/(site)/(application)/chat/ChatPageClient.tsx:333",
    "components/marketing/ChatWorkspaceGuide.tsx:186",
  ]);

  const violations = [];
  for (const { file, line, segment } of classSegments(CUSTOMER_TSX)) {
    if (!segment.includes("font-black")) continue;
    if (BRAND_EXPRESSION_ALLOWLIST.has(`${file}:${line}`)) continue;
    const sizes = sizesIn(segment);
    const largest = sizes.length ? Math.max(...sizes) : null;
    if (largest === null) {
      violations.push(`${file}:${line} (font-black with no explicit size)`);
    } else if (largest <= 16) {
      violations.push(`${file}:${line} (font-black at ${largest}px)`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `font-black on small controls:\n${violations.join("\n")}`
  );
});

test("no component pins Arial or Helvetica as a UI font", () => {
  const violations = [];
  for (const file of ALL_TSX) {
    const source = readFileSync(file, "utf8");
    if (/font-family:\s*(?:Arial|Helvetica)/i.test(source)) {
      violations.push(rel(file));
    }
  }
  assert.deepEqual(violations, [], `Hard-coded Arial UI font:\n${violations.join("\n")}`);
});

test("globals.css routes every family through the locale-aware tokens", () => {
  const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");

  assert.match(css, /body\s*\{[^}]*font-family:\s*var\(--font-ui\)/);
  assert.doesNotMatch(css, /font-family:\s*Arial/i);

  // Tailwind's font-sans / font-mono utilities must resolve to the same tokens
  // the body uses, or `font-sans` and the actual body font can drift apart.
  assert.match(css, /--font-sans:\s*var\(--font-ui\)/);
  assert.match(css, /--font-mono:\s*var\(--font-code\)/);

  assert.match(css, /:lang\(ko\)\s*\{[^}]*--font-ui:\s*var\(--font-noto-sans-kr\)/);
  assert.match(css, /:lang\(zh\)\s*\{[^}]*--font-ui:\s*var\(--font-noto-sans-sc\)/);

  for (const fallback of ["Apple SD Gothic Neo", "Malgun Gothic"]) {
    assert.ok(css.includes(fallback), `Korean stack is missing ${fallback}`);
  }
  for (const fallback of ["PingFang SC", "Microsoft YaHei"]) {
    assert.ok(css.includes(fallback), `Chinese stack is missing ${fallback}`);
  }
  for (const role of [
    "type-display",
    "type-page-title",
    "type-section-title",
    "type-body",
    "type-body-compact",
    "type-control-label",
    "type-caption",
    "type-code",
  ]) {
    assert.match(css, new RegExp(`@utility ${role} \\{`), `Missing role: ${role}`);
  }
});

test("only the Latin UI face is preloaded", () => {
  const fonts = readFileSync(join(ROOT, "lib", "fonts.ts"), "utf8");
  const declaration = (name) =>
    new RegExp(`${name}\\(\\{[^}]*\\}\\)`, "s").exec(fonts)?.[0] ?? "";

  assert.doesNotMatch(
    declaration("Geist"),
    /preload:\s*false/,
    "Geist is the default UI face and must stay preloaded"
  );
  for (const deferred of ["Geist_Mono", "Noto_Sans_KR", "Noto_Sans_SC"]) {
    assert.match(
      declaration(deferred),
      /preload:\s*false/,
      `${deferred} must not preload on every route`
    );
  }
});

test("every email template shares one web-safe font policy", () => {
  const templates = [
    "lib/accountEmails.ts",
    "lib/billingEmails.ts",
    "lib/emailLoginEmails.ts",
    "lib/providerModelCatalogReport.ts",
    "app/api/admin/test-email/route.ts",
    "app/api/feedback/route.ts",
  ];

  for (const template of templates) {
    const source = readFileSync(join(ROOT, template), "utf8");
    const declared = [...source.matchAll(/font-family:([^;"']*)/g)].map((m) => m[1].trim());
    assert.ok(declared.length > 0, `${template} declares no font-family`);
    for (const value of declared) {
      assert.ok(
        value === "${EMAIL_FONT_STACK}" || value === "${EMAIL_MONO_FONT_STACK}",
        `${template} uses an ad-hoc stack: ${value}`
      );
    }
  }

  // Webfonts are not assumed to exist in a mail client, so the stack must name
  // only installed faces -- including the CJK system faces.
  assert.doesNotMatch(EMAIL_FONT_STACK, /Inter|Geist|Noto Sans SC/);
  for (const fallback of [
    "Apple SD Gothic Neo",
    "Malgun Gothic",
    "Noto Sans KR",
    "PingFang SC",
    "Microsoft YaHei",
  ]) {
    assert.ok(EMAIL_FONT_STACK.includes(fallback), `Email stack is missing ${fallback}`);
  }
  assert.match(EMAIL_FONT_STACK, /Arial, sans-serif$/);
  assert.match(EMAIL_MONO_FONT_STACK, /monospace$/);

  // Interpolated into style="..." attributes, so no double quotes.
  assert.doesNotMatch(EMAIL_FONT_STACK, /"/);
  assert.doesNotMatch(EMAIL_MONO_FONT_STACK, /"/);
});
