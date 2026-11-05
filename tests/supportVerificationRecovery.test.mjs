import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";
import { zhHant } from "../locales/zhHant.ts";

/**
 * A failed security check used to be a dead end on the support form: the only
 * control under the error was "cancel the check", so the one channel the page
 * exists to provide was unusable until the visitor thought to reload. These
 * cover the way out -- retry the same request, or write to the support address
 * that never needed a check at all.
 */

const ROOT = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");

const supportSource = read("components/marketing/SupportPageContent.tsx");
const slotSource = read("components/chat/TurnstileFormSlot.tsx");
const hookSource = read("components/chat/useTurnstile.ts");

// ---------------------------------------------------------------------------
// The script tag: a retry has to be able to reload it
// ---------------------------------------------------------------------------

const makeDom = () => {
  const head = [];
  const element = (tagName) => {
    const handlers = new Map();
    const attributes = new Map();
    return {
      tagName,
      id: "",
      src: "",
      addEventListener: (type, handler) =>
        handlers.set(type, [...(handlers.get(type) ?? []), handler]),
      dispatch: (type) => {
        for (const handler of handlers.get(type) ?? []) handler();
      },
      hasAttribute: (name) => attributes.has(name),
      setAttribute: (name, value) => attributes.set(name, String(value)),
      remove() {
        const index = head.indexOf(this);
        if (index >= 0) head.splice(index, 1);
      },
    };
  };
  return {
    head,
    document: {
      getElementById: (id) => head.find((node) => node.id === id) ?? null,
      createElement: element,
      head: {
        appendChild: (node) => {
          head.push(node);
        },
      },
    },
  };
};

const withDom = async (run) => {
  const dom = makeDom();
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
  };
  globalThis.window = {};
  globalThis.document = dom.document;
  try {
    const { loadTurnstile } = await import(
      "../components/chat/turnstileScript.ts"
    );
    return await run({ dom, loadTurnstile });
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
  }
};

test("a load failure is recorded on the script tag it happened to", () =>
  withDom(async ({ dom, loadTurnstile }) => {
    const load = loadTurnstile();
    assert.equal(dom.head.length, 1);
    dom.head[0].dispatch("error");
    await assert.rejects(load, /Turnstile failed to load/);
    assert.equal(dom.head[0].hasAttribute("data-turnstile-load-failed"), true);
  }));

test("a retry replaces a script tag that already failed", () =>
  withDom(async ({ dom, loadTurnstile }) => {
    const first = loadTurnstile();
    const failed = dom.head[0];
    failed.dispatch("error");
    await assert.rejects(first);

    // The failed tag never fires `load` again, so attaching to it would make
    // every later attempt wait out the caller's deadline instead of retrying.
    const second = loadTurnstile();
    assert.equal(dom.head.length, 1);
    assert.notEqual(dom.head[0], failed);
    dom.head[0].dispatch("load");
    await second;
  }));

test("a pending script tag is shared rather than duplicated", () =>
  withDom(async ({ dom, loadTurnstile }) => {
    const first = loadTurnstile();
    const second = loadTurnstile();
    assert.equal(dom.head.length, 1);
    dom.head[0].dispatch("load");
    await Promise.all([first, second]);
  }));

// ---------------------------------------------------------------------------
// The hook: a verification that starts with no widget asks for a new one
// ---------------------------------------------------------------------------

test("a verification with no usable widget triggers a fresh render", () => {
  assert.match(
    hookSource,
    /const \[renderAttempt, setRenderAttempt\] = useState\(0\)/
  );
  assert.match(
    hookSource,
    /if \(!widgetIdRef\.current\) setRenderAttempt\(\(current\) => current \+ 1\)/
  );
  // The render effect has to depend on the counter, or bumping it changes
  // nothing and "unavailable" stays permanent for the life of the page.
  assert.match(hookSource, /renderAttempt,\s*\n\s*settle,/);
  // The bump must come before the readiness poll, so the poll waits for the
  // widget the new render attempt creates.
  assert.ok(
    hookSource.indexOf("setRenderAttempt((current) => current + 1)") <
      hookSource.indexOf("WIDGET_READY_TIMEOUT_MS;")
  );
});

// ---------------------------------------------------------------------------
// The slot: retry and fallback belong to a failure, not to the widget
// ---------------------------------------------------------------------------

test("retry and the fallback route render only alongside a failure", () => {
  for (const control of ["onRetry", "errorFallback"]) {
    assert.match(
      slotSource,
      new RegExp(`isChallengeVisible && failure && ${control} \\?`),
      `${control} is rendered without a failure to explain it`
    );
  }
  assert.match(slotSource, /data-testid=\{`\$\{testId\}-retry`\}/);
  assert.match(slotSource, /data-testid=\{`\$\{testId\}-fallback`\}/);
  assert.match(slotSource, /t\("chat\.guestVerificationRetry"\)/);
  // Optional props: the sign-in and chat-feedback slots pass neither and keep
  // exactly the controls they had.
  assert.match(slotSource, /onRetry\?: \(\) => void/);
  assert.match(slotSource, /errorFallback\?: ReactNode/);
});

test("retry copy exists in every locale and is not left in English", () => {
  const dictionaries = { en, ko, zh, "zh-Hant": zhHant, fr, de, es, pt };
  for (const [name, dictionary] of Object.entries(dictionaries)) {
    const copy = dictionary.chat.guestVerificationRetry;
    assert.equal(typeof copy, "string", `${name} is missing the retry label`);
    assert.ok(copy.trim().length > 0, `${name} retry label is blank`);
    if (name !== "en") {
      assert.notEqual(
        copy,
        en.chat.guestVerificationRetry,
        `${name} retry label is still English`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The support form: one submission path, kept content, offered address
// ---------------------------------------------------------------------------

test("the support form retries through its own submission path", () => {
  assert.match(supportSource, /onRetry=\{\(\) => void send\(\)\}/);
  // A retry must not be able to start a second submission.
  assert.match(supportSource, /if \(submittingRef\.current\) return;/);
  // The form's submit handler and the retry button must run the same function,
  // so a retry sends the request that already exists rather than a new one.
  assert.match(supportSource, /const send = async \(\) =>/);
  assert.match(
    supportSource,
    /const submit = \([\s\S]*?\) => \{\s*event\.preventDefault\(\);\s*void send\(\);/
  );
  assert.equal(supportSource.match(/submitFeedback\(/g)?.length, 1);
});

test("a verification failure keeps everything that was typed", () => {
  const verificationCatch = supportSource.indexOf("isGuestVerificationError");
  const storedBranch = supportSource.indexOf('setMessage("")');
  assert.ok(verificationCatch >= 0 && storedBranch >= 0);
  // The only place the draft is cleared sits after the stored-outcome check,
  // which every failure path returns before reaching.
  assert.ok(verificationCatch < storedBranch);
  assert.match(
    supportSource.slice(verificationCatch, storedBranch),
    /if \(!outcome\.ok\) \{[\s\S]*?return;\s*\}/
  );
  assert.equal(supportSource.match(/setMessage\(""\)/g)?.length, 1);
  assert.equal(supportSource.match(/setTraceId\(""\)/g)?.length, 1);
});

test("the support address is offered next to the verification error", () => {
  assert.match(supportSource, /errorFallback=\{/);
  assert.match(supportSource, /href=\{`mailto:\$\{page\.emailValue\}`\}/);
  assert.match(supportSource, /data-testid="support-verification-email"/);
  // Every locale's contact card already carries the real address, so the
  // fallback link needs no new copy and cannot drift from it.
  assert.equal(
    supportSource.match(/"emailValue": "support@tomverse\.app"/g)?.length,
    8
  );
});
