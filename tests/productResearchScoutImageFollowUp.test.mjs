import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { installCdpRules, launch } from "../lib/productResearchScoutBrowser.mjs";
import {
  SCOUT_GENERATIONS,
  SCOUT_IMAGE_FOLLOW_UP_GENERATION,
  SCOUT_IMAGE_FOLLOW_UP_TASK_ENV,
  scoutTurnWrites,
} from "../lib/productResearchScoutBrowserPolicy.mjs";
import { generateImageFollowUp } from "../lib/productResearchScoutGeneration.mjs";
import { requestedScoutGenerations, scoutSubjectInfo } from "../lib/productResearchScoutSubjects.ts";
import { SCOUT_SYSTEM_PROMPT } from "../lib/productResearchScoutCore.ts";

/**
 * The Scout's image-then-change turn (docs/policy/product-research-agent.md §14)
 * in a real Chromium, against a small chat page that does what the product does
 * on Auto: POST the turn, and when the server answers with an image turn, POST
 * the conversation's image-turn route and show the picture with its caption. The
 * page reproduces the two defects of the 2026-11-15 G4 recording -- the follow-up
 * answered as text, the caption an internal id -- so the model gets both.
 */

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==", "base64");

// The picture lives on another origin, as the product's signed storage URLs do,
// so the walker's browser (which loads only the app's origin) cannot draw it.
const chatPage = (assets) => `<!doctype html><html lang="ko"><body>
<div id="out"></div>
<textarea data-testid="chat-textarea"></textarea>
<button data-testid="chat-send-button">send</button>
<script>
const out = document.getElementById("out");
const answer = (inner) => out.insertAdjacentHTML("beforeend",
  '<div data-testid="chat-message" data-message-role="assistant"><span data-testid="assistant-message-model-name">Auto</span>' + inner + '</div>');
document.querySelector('[data-testid="chat-send-button"]').onclick = async () => {
  const prompt = document.querySelector('[data-testid="chat-textarea"]').value;
  out.insertAdjacentHTML("beforeend", '<div data-testid="chat-message" data-message-role="user">' + prompt + '</div>');
  const turn = await (await fetch("/api/chat", { method: "POST", body: prompt })).json();
  if (turn.hang) return;
  if (turn.text) return answer('<p>' + turn.text + '</p><button data-testid="memory-answer-feedback">report</button>');
  await fetch("/api/conversations/c1/image-turn", { method: "POST", body: prompt });
  if (prompt.includes("STRAYS")) await fetch("/api/images/targets/t1/retry", { method: "POST" }).catch(() => {});
  answer('<div data-testid="chat-image-turn"><figure><img src="${assets}/fox.png" alt="x"><figcaption>qwen-image-3.0</figcaption></figure></div>');
};
</script></body></html>`;

let server;
let origin;
let assets;
let assetsOrigin;
const assetReads = [];
let browser;
let rules;
const seen = [];

const place = (extra = {}) => ({
  walk: { origin, headers: {} },
  cookie: { name: "next-auth.session-token", value: "fixture-session", url: origin },
  ...extra,
});

before(async () => {
  server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://fixture");
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: request.method, pathname, body });
      const json = (value) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (pathname === "/chat") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(chatPage(assetsOrigin));
      }
      if (pathname === "/api/chat") {
        if (body.includes("HANGS")) return json({ hang: true });
        if (body.includes("TEXT")) return json({ text: "This chat cannot generate or edit raster images." });
        return json({ image: true });
      }
      if (pathname === "/api/conversations/c1/image-turn") return json({ ok: true });
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  assets = createServer((request, response) => {
    assetReads.push({ pathname: request.url, cookie: request.headers.cookie ?? "" });
    response.writeHead(200, { "content-type": "image/png" });
    response.end(PNG);
  });
  await new Promise((resolve) => assets.listen(0, "127.0.0.1", resolve));
  assetsOrigin = `http://127.0.0.1:${assets.address().port}`;
  browser = await launch([]).catch(() => null);
  if (browser) rules = await installCdpRules(browser, [origin]);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => assets.close(resolve));
});

const needsBrowser = (name, body) =>
  test(name, async (context) => {
    if (!browser) return context.skip("no browser can start here");
    await body();
  });

needsBrowser("an image, then a follow-up answered in text: both turns, both screens and the caption reach the model", async () => {
  seen.length = 0;
  assetReads.length = 0;
  const subject = await generateImageFollowUp(
    browser,
    rules,
    { id: SCOUT_IMAGE_FOLLOW_UP_GENERATION, prompt: "draw a fox", followUp: "TEXT make it night" },
    place(),
  );
  assert.equal(subject.subject, SCOUT_IMAGE_FOLLOW_UP_GENERATION);
  assert.deepEqual(subject.images.map((image) => image.label), ["chat-turn-2", "turn-1-image", "chat-turn-1"]);
  // The browser could not draw the stored picture; the walker read it itself, without the session.
  assert.match(subject.signals, /Its picture, read separately: attached as turn-1-image. Drawn in the walker's browser: 0 of 1./);
  assert.match(subject.signals, /can look broken or blank in the chat screens: that alone is the walker's/);
  assert.deepEqual(assetReads, [{ pathname: "/fox.png", cookie: "" }]);
  assert.match(subject.signals, /Turn 1 answer: 1 image\(s\)/);
  assert.match(subject.signals, /Captions under the images, exactly as shown: "qwen-image-3\.0"/);
  assert.match(subject.signals, /Turn 2 answer: 0 image\(s\)/);
  assert.match(subject.signals, /cannot generate or edit raster images/);
  const posts = seen.filter((request) => request.method === "POST").map((request) => request.pathname);
  assert.deepEqual(posts, ["/api/chat", "/api/conversations/c1/image-turn", "/api/chat"]);
  assert.equal(rules.allowWrite, null);
});

needsBrowser("no follow-up is sent when the first turn brings no image", async () => {
  seen.length = 0;
  const subject = await generateImageFollowUp(browser, rules, { id: SCOUT_IMAGE_FOLLOW_UP_GENERATION, prompt: "TEXT draw", followUp: "later" }, place());
  assert.match(subject.signals, /the follow-up was not sent/);
  assert.equal(seen.filter((request) => request.pathname === "/api/chat").length, 1);
  assert.deepEqual(subject.images.map((image) => image.label), ["chat-turn-1"]);
});

needsBrowser("only the turn's own paths write: another paid image route is refused and named", async () => {
  seen.length = 0;
  const subject = await generateImageFollowUp(browser, rules, { id: SCOUT_IMAGE_FOLLOW_UP_GENERATION, prompt: "STRAYS draw", followUp: "TEXT x" }, place());
  assert.ok(!seen.some((request) => request.pathname === "/api/images/targets/t1/retry"));
  assert.match(subject.signals, /refused these writes during the turns[^]*\/api\/images\/targets\/t1\/retry/);
});

needsBrowser("a turn that never settles is reported with its step", async () => {
  const subject = await generateImageFollowUp(
    browser,
    rules,
    { id: SCOUT_IMAGE_FOLLOW_UP_GENERATION, prompt: "HANGS", followUp: "x" },
    place({ timeoutMs: 800 }),
  );
  assert.match(subject.signals, /stopped at the step "turn_1"/);
  assert.equal(rules.allowWrite, null);
});

test("the image turn is open only to a turn that asks for it, and only a few times", () => {
  const url = "https://tomverse.app/api/conversations/c1/image-turn";
  assert.equal(scoutTurnWrites()("POST", url), false, "a file turn cannot start an image");
  const allow = scoutTurnWrites({ imageTurn: true });
  assert.deepEqual([1, 2, 3, 4].map(() => allow("POST", url)), [true, true, true, false]);
  assert.equal(allow("POST", "https://tomverse.app/api/images/generations"), false);
  assert.equal(allow("POST", "https://tomverse.app/api/images/targets/t1/retry"), false);
});

test("the follow-up generation is off unless its app switch is set, and the Admin view names it", () => {
  const generation = SCOUT_GENERATIONS.find((entry) => entry.id === SCOUT_IMAGE_FOLLOW_UP_GENERATION);
  assert.equal(generation.switchEnv, SCOUT_IMAGE_FOLLOW_UP_TASK_ENV);
  assert.ok(generation.prompt.length > 0 && generation.followUp.length > 0);
  const all = { generations: SCOUT_GENERATIONS.map((entry) => entry.id) };
  assert.ok(!requestedScoutGenerations(all, {}).includes(SCOUT_IMAGE_FOLLOW_UP_GENERATION));
  assert.ok(requestedScoutGenerations(all, { [SCOUT_IMAGE_FOLLOW_UP_TASK_ENV]: "1" }).includes(SCOUT_IMAGE_FOLLOW_UP_GENERATION));
  assert.deepEqual(scoutSubjectInfo(SCOUT_IMAGE_FOLLOW_UP_GENERATION), { kind: "file", format: "generated-image-follow-up" });
});

test("the judging prompt treats a text answer to a follow-up and a shown internal id as findings", () => {
  assert.match(SCOUT_SYSTEM_PROMPT, /follow-up that asks to change the previous image[^.]*answered in text/);
  assert.match(SCOUT_SYSTEM_PROMPT, /internal identifier shown to a user is a finding/);
});
