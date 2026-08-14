import assert from "node:assert/strict";
import test from "node:test";

import ts from "typescript";

import {
  classifyFile,
  classifyRequestTarget,
  runtimeFor,
  summarise,
} from "../scripts/report-unconsumed-response-bodies-core.mjs";

/**
 * The scanner behind .github/audits/unconsumed-response-bodies-2026-08-13.md.
 *
 * Its whole value is that a reader can trust the three buckets, so what is
 * tested here is the boundary between them -- particularly the shapes this
 * repository actually writes, where a keyword search would answer wrongly in
 * both directions: `res.ok ? res.json() : null` reads the body in the source
 * and still leaves a path unread, and `if (!ok) { discard; return; }` never
 * mentions the success path and still covers it.
 */

const kinds = (source, file = "components/Example.tsx") =>
  classifyFile(ts, file, source).map((finding) => finding.kind);

const one = (source) => {
  const found = kinds(source);
  assert.equal(found.length, 1, `expected one call site, found ${found.length}`);
  return found[0];
};

test("a ternary that reads only the success arm leaves a path unread", () => {
  assert.equal(
    one(`fetch("/api/x").then((res) => (res.ok ? res.json() : null));`),
    "leaks"
  );
});

test("a ternary whose other arm discards is consumed on both", () => {
  assert.equal(
    one(
      `fetch("/api/x").then((res) =>
         res.ok ? res.json() : discardResponseBody(res).then(() => null)
       );`
    ),
    "consumed"
  );
});

test("an early return after discarding covers the path it leaves on", () => {
  assert.equal(
    one(
      `async function load() {
         const res = await fetch("/api/x");
         if (!res.ok) {
           await discardResponseBody(res);
           return null;
         }
         return res.json();
       }`
    ),
    "consumed"
  );
});

test("an early throw without a read is the path this exists to find", () => {
  assert.equal(
    one(
      `async function load() {
         const res = await fetch("/api/x");
         if (!res.ok) throw new Error("failed");
         return res.json();
       }`
    ),
    "leaks"
  );
});

test("reading in both arms of an if/else is consumed", () => {
  assert.equal(
    one(
      `async function load() {
         const res = await fetch("/api/x");
         if (res.ok) {
           apply(await res.json());
         } else {
           await res.text();
         }
       }`
    ),
    "consumed"
  );
});

test("reading only inside the success branch falls through unread", () => {
  assert.equal(
    one(
      `async function load() {
         const res = await fetch("/api/x");
         if (res.ok) apply(await res.json());
       }`
    ),
    "leaks"
  );
});

test("an unconditional read after the binding is consumed", () => {
  assert.equal(
    one(
      `async function load() {
         const res = await fetch("/api/x");
         const body = await res.json().catch(() => null);
         return body;
       }`
    ),
    "consumed"
  );
});

test("a response nobody binds is unread", () => {
  assert.equal(one(`void fetch("/api/x", { method: "DELETE" });`), "leaks");
});

test("an awaited response nobody binds is unread", () => {
  assert.equal(
    one(`async function go() { await fetch("/api/x", { method: "DELETE" }); }`),
    "leaks"
  );
});

test("then(discardResponseBody) is consumed", () => {
  assert.equal(
    one(`fetch("/api/x", { method: "PATCH" }).then(discardResponseBody);`),
    "consumed"
  );
});

test("a body read through the stream counts", () => {
  assert.equal(
    one(
      `async function go() {
         const res = await fetch("/api/x");
         await res.body?.cancel();
       }`
    ),
    "consumed"
  );
});

test("a returned promise escapes rather than being judged", () => {
  assert.equal(
    one(`const send = () => fetch("/api/x", { method: "POST" });`),
    "escapes"
  );
});

test("a response handed to another function escapes", () => {
  assert.equal(
    one(
      `async function go() {
         const res = await fetch("/api/x");
         return handle(res);
       }`
    ),
    "escapes"
  );
});

test("a loop body is not treated as certain to run", () => {
  assert.equal(
    one(
      `async function go(items) {
         const res = await fetch("/api/x");
         for (const item of items) {
           await res.json();
         }
       }`
    ),
    "leaks"
  );
});

test("every call site in a file is reported, not only the first", () => {
  assert.deepEqual(
    kinds(
      `async function go() {
         const a = await fetch("/api/a");
         await a.text();
         const b = await fetch("/api/b");
         if (b.ok) await b.json();
       }`
    ),
    ["consumed", "leaks"]
  );
});

test("a finding carries the file, line and request it describes", () => {
  const [finding] = classifyFile(
    ts,
    "components/chat/Thing.tsx",
    `\nasync function go() {\n  const res = await fetch("/api/user/guest-usage");\n  if (res.ok) await res.json();\n}\n`
  );
  assert.equal(finding.file, "components/chat/Thing.tsx");
  assert.equal(finding.line, 3);
  assert.equal(finding.request, `"/api/user/guest-usage"`);
  assert.equal(finding.kind, "leaks");
});

test("the runtime split reads the source before falling back to the directory", () => {
  assert.equal(runtimeFor("components/chat/ChatInput.tsx"), "browser");
  assert.equal(runtimeFor("app/(site)/(application)/chat/ChatPageClient.tsx"), "browser");
  assert.equal(runtimeFor("app/api/chat/route.ts"), "server");
  assert.equal(runtimeFor("scripts/check-openai-model-access.mjs"), "server");
  assert.equal(runtimeFor("packages/chat-core/src/index.ts"), "browser");
  // lib/ holds both halves, so it is only decided by a signal in the file.
  assert.equal(runtimeFor("lib/anything.ts"), "either");
  assert.equal(
    runtimeFor("lib/perplexityDeepResearch.ts", 'import "server-only";\n'),
    "server"
  );
  assert.equal(runtimeFor("lib/useBuildInfo.ts", '"use client";\n'), "browser");
});

test("a finding carries the runtime of the file it came from", () => {
  const [finding] = classifyFile(
    ts,
    "lib/thing.ts",
    '"use client";\nasync function go() { await fetch("/api/x"); }\n'
  );
  assert.equal(finding.runtime, "browser");
});

test("the summary counts every finding once, by kind and by runtime", () => {
  const findings = [
    { file: "components/A.tsx", kind: "leaks", runtime: "browser" },
    { file: "components/B.tsx", kind: "consumed", runtime: "browser" },
    { file: "app/api/c/route.ts", kind: "leaks", runtime: "server" },
  ];
  const { total, byKind, byRuntime } = summarise(findings);
  assert.equal(total, 3);
  assert.equal(byKind.get("leaks"), 2);
  assert.equal(byKind.get("consumed"), 1);
  assert.equal(byRuntime.get("browser").get("leaks"), 1);
  assert.equal(byRuntime.get("server").get("leaks"), 1);
});

test("only a same-origin /api/* route on the proxy default is the measured case", () => {
  const exceptions = ["/api/models/status", "/api/chat"];
  assert.equal(
    classifyRequestTarget(`"/api/user/guest-usage"`, exceptions),
    "api_default_no_store"
  );
  assert.equal(
    classifyRequestTarget(`"/api/models/status"`, exceptions),
    "api_own_caching"
  );
  assert.equal(
    classifyRequestTarget(`"/api/chat"`, exceptions),
    "api_own_caching"
  );
  assert.equal(
    classifyRequestTarget(`"https://api.resend.com/emails"`, exceptions),
    "cross_origin"
  );
  assert.equal(classifyRequestTarget(`"/pricing"`, exceptions), "same_origin_other");
  // A template or a variable is not resolvable here, and is not guessed at.
  assert.equal(classifyRequestTarget("uploadUrl", exceptions), "unresolved");
  assert.equal(
    classifyRequestTarget("`/api/conversations/${id}`", exceptions),
    "api_default_no_store"
  );
});

test("a response assigned to a variable declared earlier is still tracked", () => {
  // lib/feedbackClient.ts's shape: `let response: Response` above, assigned
  // inside a try. Reading only `const x = await fetch()` reported this as
  // dropping a body it consumes on both paths.
  assert.equal(
    one(
      `async function go() {
         let response;
         try {
           response = await fetch("/api/x");
         } catch {
           return null;
         }
         return response.json();
       }`
    ),
    "consumed"
  );
});

test("a response chosen by a ternary is still tracked", () => {
  assert.equal(
    one(
      `async function go(guest) {
         const response = guest ? await other() : await fetch("/api/x");
         if (!response.ok) return null;
         return response.json();
       }`
    ),
    "leaks"
  );
});

test("a read inside a returned object literal counts as consumed", () => {
  assert.equal(
    one(
      `async function go() {
         const response = await fetch("/api/x");
         if (response.ok) {
           return { ok: true, body: await response.json() };
         }
         return { ok: false, body: await response.text() };
       }`
    ),
    "consumed"
  );
});

/**
 * The four shapes this scanner once reported as leaking, on code that consumed
 * its body perfectly well.
 *
 * They are grouped here because they share a job: a gate is only worth
 * blocking a merge with if the shapes it has already been wrong about stay
 * fixed. Two of them were pinned as a side effect of other tests — the
 * pre-declared variable and the returned object literal, above — and two were
 * not pinned at all until this block. `Promise.all` appeared nowhere in this
 * file, and the ternary test above only fixed the *leaking* case, so the
 * ComparisonReviewDialog shape could have regressed with every test green.
 */

test("false positive 1: a fetch inside Promise.all escapes rather than leaking", () => {
  // components/auth/AuthButton.tsx:418. Both responses are consumed in the
  // destructuring handler, which this walk cannot follow -- so the honest
  // answer is `escapes`, and it must never drift back to `leaks`.
  assert.deepEqual(
    kinds(
      `async function go() {
         Promise.all([
           fetch("/api/memories/settings", { cache: "no-store" }),
           fetch("/api/memories?status=candidate&limit=1"),
         ]).then(async ([settings, candidates]) => {
           if (!settings.ok || !candidates.ok) return;
           apply(await settings.json(), await candidates.json());
         });
       }`
    ),
    ["escapes", "escapes"]
  );
});

test("false positive 2: a ternary-chosen promise consumed later is not a leak", () => {
  // components/chat/ComparisonReviewDialog.tsx:430. Both promises are chosen by
  // a ternary, stored, and consumed through the variable. `escapes` is the
  // honest answer -- the consumer is a step this walk does not follow -- and
  // the point of pinning it is that it must never drift back to `leaks`.
  assert.deepEqual(
    kinds(
      `async function go(guest) {
         const request = guest
           ? fetch("/api/chat/comparison-review/preview", { method: "POST" })
           : fetch("/api/conversations/1/comparison-reviews");
         void request.then(async (response) => {
           apply(await response.json().catch(() => ({})));
         });
       }`
    ),
    ["escapes", "escapes"]
  );
});

test("false positive 2b: a ternary-chosen response read on every path is consumed", () => {
  // The awaited form of the same shape, and the one that must say `consumed`
  // rather than `escapes`: the body really is read, on both arms.
  assert.equal(
    one(
      `async function go(guest) {
         let response = guest ? await sendGuestRun() : await fetch("/api/x");
         const data = await response.json().catch(() => ({}));
         return data;
       }`
    ),
    "consumed"
  );
});

test("false positive 3: assigned in a try and used after it is not a leak", () => {
  // lib/feedbackClient.ts:123, as written: the body is read on both paths, but
  // through a helper. So the answer is `escapes` -- this walk declines to judge
  // rather than claiming either way -- and what was fixed is that it is no
  // longer reported as leaking a body it demonstrably consumes.
  assert.equal(
    one(
      `async function go(payload) {
         let response;
         try {
           response = await fetch("/api/feedback", { method: "POST" });
         } catch {
           return { ok: false };
         }
         if (response.ok) return { ok: true, body: await readJsonSafely(response) };
         const body = await readJsonSafely(response);
         return { ok: false, body };
       }`
    ),
    "escapes"
  );
});

test("false positive 3b: the same shape reading inline is consumed", () => {
  // Without the helper there is nothing to decline to judge, and this is the
  // capability the fix actually added: the walk continues out of the `try` into
  // the statements that follow it.
  assert.equal(
    one(
      `async function go(payload) {
         let response;
         try {
           response = await fetch("/api/feedback", { method: "POST" });
         } catch {
           return { ok: false };
         }
         const body = await response.json().catch(() => null);
         return { ok: response.ok, body };
       }`
    ),
    "consumed"
  );
});

test("false positive 4: a read inside a returned object literal is consumed", () => {
  // components/memory/MemoryReviewSettings.tsx:145.
  assert.equal(
    one(
      `async function apiRequest(input, init) {
         const response = await fetch(input, init);
         if (response.ok) {
           return { ok: true, body: await response.json().catch(() => null) };
         }
         const body = await response.json().catch(() => null);
         return { ok: false, failure: { status: response.status, body } };
       }`,
      "components/Example.tsx"
    ),
    "consumed"
  );
});

test("false positive 5: a local binding named `fetch` is not the global", () => {
  // lib/accountDataExport.ts:814. `const fetch = FETCHERS[domain]` then
  // `await fetch(userId)` is a database read: no network, no `Response`, no
  // body to leave unread. Matching the identifier alone reported it as a leak,
  // and it was counted among the server-side findings for a day.
  assert.deepEqual(
    kinds(
      `async function collect(userId) {
         const data = {};
         for (const declaration of DECLARATIONS) {
           const fetch = FETCHERS[declaration.domain];
           if (!fetch) continue;
           const rows = await fetch(userId);
           data[declaration.name] = rows;
         }
         return data;
       }`,
      "lib/accountDataExport.ts"
    ),
    []
  );
});

test("a parameter named `fetch` shadows the global too", () => {
  assert.deepEqual(
    kinds(
      `async function load(fetch, url) {
         const rows = await fetch(url);
         return rows;
       }`,
      "lib/example.ts"
    ),
    []
  );
});

test("shadowing in one scope does not exempt the real global in another", () => {
  // The check walks enclosing scopes from the call, so a `const fetch` in one
  // function cannot silence a genuine call site in the next one. A file-wide
  // check would have done exactly that.
  assert.deepEqual(
    kinds(
      `async function shadowed() {
         const fetch = FETCHERS.a;
         return await fetch("x");
       }
       async function real() {
         const response = await fetch("/api/thing");
         if (!response.ok) return null;
         return response.json();
       }`,
      "lib/example.ts"
    ),
    ["leaks"]
  );
});
