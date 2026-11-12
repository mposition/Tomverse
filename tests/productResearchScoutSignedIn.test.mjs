import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  SCOUT_ATTACHMENT_TASK_ENV,
  SCOUT_EXPLORE_GENERATION,
  SCOUT_EXPLORE_TASK_ENV,
  SCOUT_FIXTURES,
  SCOUT_GENERATIONS,
  SCOUT_PAGE_ORIGIN,
  admitScenario,
  scenarioTask,
  SCOUT_PAGE_ORIGINS,
  SCOUT_SIGNED_IN_PAGES,
  decideScoutRequest,
  isSignedOutPath,
  scoutTurnWrites,
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

test("POST is open only during a turn, and only to an allowed origin", () => {
  const post = { method: "POST", url: "https://tomverse.app/api/chat", allowedOrigins: ["https://tomverse.app"] };
  assert.deepEqual(decideScoutRequest(post), { allow: false, reason: "method" });
  assert.deepEqual(decideScoutRequest({ ...post, allowWrite: null }), { allow: false, reason: "method" });
  assert.deepEqual(decideScoutRequest({ ...post, allowWrite: scoutTurnWrites() }), { allow: true });
  assert.deepEqual(
    decideScoutRequest({ ...post, url: "https://example.com/api/chat", allowWrite: scoutTurnWrites() }),
    { allow: false, reason: "origin" },
  );
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    assert.deepEqual(decideScoutRequest({ ...post, method, allowWrite: scoutTurnWrites() }), { allow: false, reason: "method" });
  }
  // A read is not the turn's to count.
  const allowWrite = scoutTurnWrites();
  for (let index = 0; index < 20; index += 1) {
    assert.deepEqual(decideScoutRequest({ ...post, method: "GET", allowWrite }), { allow: true });
  }
  assert.equal(allowWrite("POST", "https://tomverse.app/api/chat"), true);
});

test("a turn reaches only its own paths, a bounded number of times", () => {
  const origin = "https://tomverse.app";
  const allowWrite = scoutTurnWrites();
  for (let index = 0; index < 3; index += 1) assert.equal(allowWrite("POST", `${origin}/api/chat`), true, `chat post ${index}`);
  assert.equal(allowWrite("POST", `${origin}/api/chat`), false, "no more than one a model");
  for (const path of [
    "/api/products/chat/conversations",
    "/api/chat/preflight",
    "/api/chat/availability",
    "/api/chat/concurrency",
    "/api/chat/context",
    "/api/chat/conversation-title",
    "/api/chat/image-intent",
    "/api/chat/location-intent",
    "/api/chat/prompt-refiner/prepare",
    "/api/conversations/c1/messages",
    "/api/conversations/c1/messages/receipt",
    "/api/conversations/c1/generate-title",
  ]) {
    assert.equal(scoutTurnWrites()("POST", `${origin}${path}`), true, path);
  }
  // The composer saves its draft before it sends, and drops it after.
  for (const method of ["PUT", "DELETE"]) {
    assert.equal(scoutTurnWrites()(method, `${origin}/api/products/chat/drafts/scope-1`), true, method);
    assert.equal(scoutTurnWrites()(method, `${origin}/api/conversations/c1`), false, `${method} a conversation`);
    assert.equal(scoutTurnWrites()(method, `${origin}/api/chat`), false, `${method} the turn`);
  }
  assert.equal(scoutTurnWrites()("POST", `${origin}/api/products/chat/drafts/scope-1`), false);
  assert.equal(scoutTurnWrites()("PATCH", `${origin}/api/products/chat/drafts/scope-1`), false);
  // Every other paid or state-changing route stays shut during the turn.
  for (const path of [
    "/api/chat/voice",
    "/api/chat/voice-transcription",
    "/api/chat/deep-research/status",
    "/api/chat/compare-summary",
    "/api/chat/comparison-review",
    "/api/images/generations",
    "/api/conversations/c1/image-turn",
    "/api/conversations/c1/generations",
    "/api/conversations/c1/share",
    "/api/conversations/c1/compare-summary",
    "/api/user/settings",
    "/api/billing/checkout",
    "/api/account/delete",
  ]) {
    assert.equal(scoutTurnWrites()("POST", `${origin}${path}`), false, path);
  }
  const support = scoutTurnWrites();
  for (let index = 0; index < 40; index += 1) assert.equal(support("POST", `${origin}/api/chat/context`), true);
  assert.equal(support("POST", `${origin}/api/chat/context`), false, "the composer's own calls are bounded too");
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
  assert.deepEqual(requestedScoutGenerations({ generations: ["generated.image", "generated.pdf", "generated.secret"] }, {}), ["generated.pdf", "generated.image"]);
  for (const body of [null, {}, { generations: "generated.pdf" }, []]) assert.deepEqual(requestedScoutGenerations(body, {}), []);
});

test("the attachment and model-written turns get no permit until their own app switch is on, and come last", () => {
  const all = { generations: SCOUT_GENERATIONS.map((generation) => generation.id) };
  const fixed = ["generated.pdf", "generated.docx", "generated.xlsx", "generated.pptx", "generated.image"];
  assert.deepEqual(requestedScoutGenerations(all, {}), fixed);
  assert.deepEqual(requestedScoutGenerations(all, { [SCOUT_ATTACHMENT_TASK_ENV]: " " }), fixed, "blank is off");
  assert.deepEqual(requestedScoutGenerations(all, { [SCOUT_ATTACHMENT_TASK_ENV]: "1" }), [...fixed, "generated.attachment-pdf"]);
  assert.deepEqual(
    requestedScoutGenerations(all, { [SCOUT_ATTACHMENT_TASK_ENV]: "1", [SCOUT_EXPLORE_TASK_ENV]: "1" }),
    [...fixed, "generated.attachment-pdf", SCOUT_EXPLORE_GENERATION],
  );
  assert.deepEqual(SCOUT_GENERATIONS.filter((generation) => generation.switchEnv === null).map((generation) => generation.id), fixed);
});

test("a scenario runs only with a bounded request and the walker's own fixtures, each once", () => {
  const good = { prompt: " 두 이미지를 PDF로 합쳐 주세요 ", attachments: ["chart.png", "receipt.jpg"], expectation: "PDF 한 개" };
  assert.deepEqual(admitScenario(good), { prompt: "두 이미지를 PDF로 합쳐 주세요", attachments: ["chart.png", "receipt.jpg"], expectation: "PDF 한 개" });
  assert.deepEqual(scenarioTask({ scenario: { ...good, attachments: [] } })?.attachments, []);
  for (const bad of [
    null,
    { ...good, prompt: "" },
    { ...good, prompt: "x".repeat(501) },
    { ...good, attachments: ["id-card.jpg"] },
    { ...good, attachments: ["../chart.png"] },
    { ...good, attachments: ["chart.png", "chart.png"] },
    { ...good, attachments: ["chart.png", "receipt.jpg", "sales.csv", "chart.png"] },
    { ...good, attachments: "chart.png" },
    { ...good, expectation: 3 },
    { ...good, expectation: "  " },
  ]) {
    assert.equal(admitScenario(bad), null, JSON.stringify(bad));
  }
  assert.equal(scenarioTask({ judged: false, reason: "model_off" }), null);
  for (const name of Object.keys(SCOUT_FIXTURES)) assert.match(SCOUT_FIXTURES[name].mediaType, /^(image\/(png|jpeg)|text\/csv)$/);
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
  const messages = read("lib/adminMessages/productResearchScout.ts");
  for (const generation of SCOUT_GENERATIONS) {
    const info = scoutSubjectInfo(generation.id);
    assert.equal(info.kind, "file", generation.id);
    assert.equal(messages.split(`"${info.format}":`).length, 3, `both languages name ${info.format}`);
    // The model-written turn has no fixed sentence: the scenario route writes it on the day.
    if (generation.id === SCOUT_EXPLORE_GENERATION) assert.equal(generation.prompt, "");
    else assert.ok(generation.prompt.length > 0 && generation.prompt.length < 500);
    for (const name of generation.attachments) assert.ok(Object.hasOwn(SCOUT_FIXTURES, name), name);
  }
});

test("the controls the walker drives exist in the product under those test ids", () => {
  const walker = read("lib/productResearchScoutGeneration.mjs");
  const owners = {
    "chat-textarea": "components/chat/ChatInput.tsx",
    "chat-send-button": "components/chat/ChatInput.tsx",
    "attachment-complete": "components/chat/ChatInput.tsx",
    "generated-artifact-download": "components/chat/GeneratedArtifactCard.tsx",
    "generated-artifact-failure": "components/chat/GeneratedArtifactCard.tsx",
    "chat-message": "components/chat/ChatMessageList.tsx",
    "chat-error-icon": "components/chat/ChatMessageList.tsx",
    "assistant-message-model-name": "components/chat/ChatMessageList.tsx",
  };
  for (const [testId, path] of Object.entries(owners)) {
    assert.ok(walker.includes(testId), `walker uses ${testId}`);
    assert.ok(read(path).includes(`data-testid="${testId}"`), `${path} renders ${testId}`);
  }
  // The finished answer's report button takes its test id as a prop.
  assert.ok(walker.includes("memory-answer-feedback"));
  assert.ok(read("components/chat/ChatMessageList.tsx").includes('triggerTestId="memory-answer-feedback"'));
});

test("every signed-in screen the walker opens is a page the app has", () => {
  for (const { path } of SCOUT_SIGNED_IN_PAGES) {
    read(`app/(site)/(application)${path}/page.tsx`);
  }
});

test("the POST opening is scoped to the file turn and closed again", () => {
  const walker = read("lib/productResearchScoutGeneration.mjs");
  const opened = walker.indexOf("rules.allowWrite = scoutTurnWrites();");
  assert.ok(opened > 0);
  assert.equal(walker.split("rules.allowWrite = scoutTurnWrites();").length, 2, "opened once");
  assert.ok(opened < walker.indexOf('getByTestId("chat-send-button").click()'), "opened as send is pressed");
  assert.ok(walker.indexOf('getByTestId("chat-textarea").fill') < opened, "typing cannot write");
  assert.match(walker, /finally \{\n    rules\.allowWrite = null;/);
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
