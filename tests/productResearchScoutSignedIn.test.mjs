import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  SCOUT_ALLOWED_METHODS,
  SCOUT_GENERATION_METHODS,
  SCOUT_GENERATIONS,
  SCOUT_PAGE_ORIGIN,
  SCOUT_PAGE_ORIGINS,
  SCOUT_SIGNED_IN_PAGES,
  decideScoutRequest,
  isSignedOutPath,
  scoutWalkTarget,
  signedInAccess,
} from "../lib/productResearchScoutBrowserPolicy.mjs";
import { requestedScoutGenerations, scoutSubjectInfo } from "../lib/productResearchScoutSubjects.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const ingestUrl = "https://dev.tomverse.app/api/internal/product-research/scout";
const answer = {
  session: { name: "__Secure-next-auth.session-token", value: "token", expiresAt: "2026-11-05T01:00:00.000Z" },
  permits: ["generated.pdf", "generated.image"],
};

test("the walker walks production unless told otherwise, and production never gets the Access token", () => {
  assert.deepEqual(scoutWalkTarget({}), { origin: SCOUT_PAGE_ORIGIN, headers: {} });
  assert.deepEqual(scoutWalkTarget({ origin: "  " }), { origin: SCOUT_PAGE_ORIGIN, headers: {} });
  assert.deepEqual(
    scoutWalkTarget({ origin: SCOUT_PAGE_ORIGIN, accessClientId: "id", accessClientSecret: "secret" }),
    { origin: SCOUT_PAGE_ORIGIN, headers: {} },
  );
});

test("dev and Test need the whole Access token, and no other origin can be chosen", () => {
  assert.deepEqual(scoutWalkTarget({ origin: "https://dev.tomverse.app", accessClientId: "id", accessClientSecret: "secret" }), {
    origin: "https://dev.tomverse.app",
    headers: { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "secret" },
  });
  assert.deepEqual(scoutWalkTarget({ origin: "https://staging.tomverse.app", accessClientId: "id" }), { refused: "access_token" });
  assert.deepEqual(scoutWalkTarget({ origin: "https://dev.tomverse.app" }), { refused: "access_token" });
  for (const origin of ["https://example.com", "http://dev.tomverse.app", "https://dev.tomverse.app/", "https://dev.tomverse.app.example.com"]) {
    assert.deepEqual(scoutWalkTarget({ origin, accessClientId: "id", accessClientSecret: "secret" }), { refused: "page_origin" });
  }
  assert.equal(SCOUT_PAGE_ORIGINS.length, 3);
});

test("POST is open only with the generation methods, and only to an allowed origin", () => {
  const post = { method: "POST", url: "https://tomverse.app/api/chat", allowedOrigins: ["https://tomverse.app"] };
  assert.deepEqual(decideScoutRequest(post), { allow: false, reason: "method" });
  assert.deepEqual(decideScoutRequest({ ...post, allowedMethods: SCOUT_ALLOWED_METHODS }), { allow: false, reason: "method" });
  assert.deepEqual(decideScoutRequest({ ...post, allowedMethods: SCOUT_GENERATION_METHODS }), { allow: true });
  assert.deepEqual(
    decideScoutRequest({ ...post, url: "https://example.com/collect", allowedMethods: SCOUT_GENERATION_METHODS }),
    { allow: false, reason: "origin" },
  );
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    assert.deepEqual(decideScoutRequest({ ...post, method, allowedMethods: SCOUT_GENERATION_METHODS }), { allow: false, reason: "method" });
  }
});

test("the session goes only to the origin whose app issued it, as a secure cookie", () => {
  const access = signedInAccess(answer, { ingestUrl, origin: "https://dev.tomverse.app" });
  assert.deepEqual(access.permits, ["generated.pdf", "generated.image"]);
  assert.equal(access.cookie.url, "https://dev.tomverse.app");
  assert.equal(access.cookie.secure, true);
  assert.equal(access.cookie.httpOnly, true);
  assert.equal(access.cookie.expires, Date.parse(answer.session.expiresAt) / 1000);
  assert.deepEqual(signedInAccess(answer, { ingestUrl, origin: "https://tomverse.app" }), { refused: "origin_mismatch" });
});

test("anything but a session cookie, and any unknown permit, is not taken from the answer", () => {
  const place = { ingestUrl, origin: "https://dev.tomverse.app" };
  assert.deepEqual(signedInAccess({}, place), { refused: "no_session" });
  assert.deepEqual(signedInAccess({ session: { ...answer.session, name: "other" } }, place), { refused: "no_session" });
  assert.deepEqual(signedInAccess({ session: { ...answer.session, value: "" } }, place), { refused: "no_session" });
  assert.deepEqual(signedInAccess({ session: { ...answer.session, expiresAt: "soon" } }, place), { refused: "no_session" });
  const access = signedInAccess({ ...answer, permits: ["generated.pdf", "generated.secret", 7] }, place);
  assert.deepEqual(access.permits, ["generated.pdf"]);
  assert.deepEqual(signedInAccess({ session: answer.session }, place).permits, []);
});

test("a page that ended on the sign-in screens reads as signed out", () => {
  assert.equal(isSignedOutPath("https://tomverse.app/auth/signin?callbackUrl=%2Fchat"), true);
  assert.equal(isSignedOutPath("https://tomverse.app/chat"), false);
  assert.equal(isSignedOutPath("not a url"), false);
});

test("the walker asks only for generations the table knows, in the table's order", () => {
  assert.deepEqual(requestedScoutGenerations({ generations: ["generated.image", "generated.pdf", "generated.secret"] }), ["generated.pdf", "generated.image"]);
  for (const body of [null, {}, { generations: "generated.pdf" }, []]) assert.deepEqual(requestedScoutGenerations(body), []);
});

test("every signed-in screen and generation is a subject the route admits and the Admin view names", () => {
  const subject = /^[a-z0-9][a-z0-9.\-_]{0,63}$/;
  const ids = [...SCOUT_SIGNED_IN_PAGES, ...SCOUT_GENERATIONS].map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, subject);
  for (const page of SCOUT_SIGNED_IN_PAGES) {
    assert.equal(scoutSubjectInfo(page.id).kind, "page", page.id);
    assert.equal(scoutSubjectInfo(page.id).href, page.path);
  }
  for (const generation of SCOUT_GENERATIONS) {
    assert.equal(scoutSubjectInfo(generation.id).kind, "file", generation.id);
    assert.ok(generation.prompt.length > 0 && generation.prompt.length < 500);
  }
});

test("the controls the walker drives exist in the product under those test ids", () => {
  const walker = read("lib/productResearchScoutGeneration.mjs");
  const owners = {
    "chat-textarea": "components/chat/ChatInput.tsx",
    "chat-send-button": "components/chat/ChatInput.tsx",
    "generated-artifact-download": "components/chat/GeneratedArtifactCard.tsx",
    "generated-artifact-failure": "components/chat/GeneratedArtifactCard.tsx",
  };
  for (const [testId, path] of Object.entries(owners)) {
    assert.ok(walker.includes(testId), `walker uses ${testId}`);
    assert.ok(read(path).includes(`data-testid="${testId}"`), `${path} renders ${testId}`);
  }
});

test("every signed-in screen the walker opens is a page the app has", () => {
  for (const { path } of SCOUT_SIGNED_IN_PAGES) {
    read(`app/(site)/(application)${path}/page.tsx`);
  }
});

test("the POST opening is scoped to the file turn and closed again", () => {
  const walker = read("lib/productResearchScoutGeneration.mjs");
  const opened = walker.indexOf("rules.allowedMethods = SCOUT_GENERATION_METHODS;");
  const closed = walker.indexOf("rules.allowedMethods = SCOUT_ALLOWED_METHODS;");
  assert.ok(opened > 0 && closed > opened);
  assert.equal(walker.split("rules.allowedMethods = SCOUT_GENERATION_METHODS;").length, 2);
  assert.match(walker.slice(closed - 60, closed), /finally \{/);
});

test("nothing the session route answers is logged", () => {
  const route = read("app/api/internal/product-research/scout/signed-in/route.ts");
  assert.equal(/console\./.test(route), false);
  const walker = read("scripts/agents/product-research-scout.mjs");
  assert.equal(/console\.[a-z]+\([^)]*(access\.cookie|session\.value|answer\.session)/.test(walker), false);
});

test("with no test account the session route does not exist, and it never answers without the secret", async () => {
  const saved = { ...process.env };
  try {
    const { POST } = await import("../app/api/internal/product-research/scout/signed-in/route.ts");
    const request = (authorization) =>
      new Request("https://tomverse.app/api/internal/product-research/scout/signed-in", {
        method: "POST",
        headers: authorization ? { authorization } : {},
        body: JSON.stringify({ generations: [] }),
      });
    const secret = "s".repeat(32);

    delete process.env.PRODUCT_RESEARCH_SCOUT_ENABLED;
    delete process.env.PRODUCT_RESEARCH_SCOUT_TEST_ACCOUNT_EMAIL;
    process.env.PRODUCT_RESEARCH_SCOUT_INGEST_SECRET = secret;
    assert.equal((await POST(request(`Bearer ${secret}`))).status, 404, "switch off");

    process.env.PRODUCT_RESEARCH_SCOUT_ENABLED = "1";
    assert.equal((await POST(request(`Bearer ${secret}`))).status, 404, "no test account");

    process.env.PRODUCT_RESEARCH_SCOUT_TEST_ACCOUNT_EMAIL = "scout-test@example.invalid";
    assert.equal((await POST(request(null))).status, 401, "no secret");
    assert.equal((await POST(request("Bearer wrong"))).status, 401, "wrong secret");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
