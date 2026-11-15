import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { installCdpRules, launch } from "../lib/productResearchScoutBrowser.mjs";
import {
  JOURNEY_ANCHORS,
  JOURNEY_PATHS,
  JOURNEY_SENDS_MAX,
  JOURNEY_STEPS_MAX,
  SCOUT_FIXTURES,
  SCOUT_GENERATIONS,
  SCOUT_JOURNEY_GENERATION,
  SCOUT_JOURNEY_TASK_ENV,
  admitJourney,
  journeyTask,
  scoutJourneyWrites,
} from "../lib/productResearchScoutBrowserPolicy.mjs";
import { walkJourney } from "../lib/productResearchScoutJourney.mjs";
import {
  JOURNEY_JUDGE_CALLS,
  JOURNEY_OUTPUT_SCHEMA,
  JOURNEY_SUBJECT,
  JOURNEY_SYSTEM_PROMPT,
  journeyPromptText,
  runJourney,
} from "../lib/productResearchScoutJourneyCore.ts";
import { SCOUT_SYSTEM_PROMPT } from "../lib/productResearchScoutCore.ts";
import { requestedScoutGenerations, scoutSubjectInfo } from "../lib/productResearchScoutSubjects.ts";

const journey = {
  viewport: "phone",
  start: { text: "보고서 초안", attachments: [] },
  steps: [
    { action: "click", value: "menu" },
    { action: "click", value: "conversation:1" },
    { action: "click", value: "삭제" },
    { action: "click", value: "new-chat" },
    { action: "type", value: "질문 하나" },
    { action: "send", value: "" },
  ],
  expectation: "대화를 고르면 목록이 닫히고, 새 작업으로 돌아오면 쓰던 초안이 그대로 있어야 합니다.",
};

// ---------------------------------------------------------------- the check on a planned journey

test("a planned journey is kept only when the walker can follow it", () => {
  assert.deepEqual(admitJourney(journey), journey);
  assert.deepEqual(journeyTask({ journey }), journey);
  assert.equal(admitJourney({ ...journey, viewport: "tv" }), null);
  assert.equal(admitJourney({ ...journey, steps: [{ action: "open", value: "/admin" }] }), null, "only the signed-in screens");
  assert.equal(admitJourney({ ...journey, steps: [{ action: "press", value: "Control+W" }] }), null);
  assert.equal(admitJourney({ ...journey, steps: [{ action: "drag", value: "x" }] }), null);
  assert.equal(admitJourney({ ...journey, steps: Array(JOURNEY_STEPS_MAX + 1).fill({ action: "back", value: "" }) }), null);
  assert.equal(admitJourney({ ...journey, steps: Array(JOURNEY_SENDS_MAX + 1).fill({ action: "send", value: "" }) }), null);
  assert.equal(admitJourney({ ...journey, start: { text: "", attachments: ["passport.jpg"] } }), null);
  assert.equal(admitJourney({ ...journey, expectation: "" }), null);
  assert.deepEqual(admitJourney({ ...journey, steps: [{ action: "back", value: "ignored" }] }).steps, [{ action: "back", value: "" }]);
  for (const path of JOURNEY_PATHS) assert.ok(admitJourney({ ...journey, steps: [{ action: "open", value: path }] }), path);
});

test("between sends a journey writes only Chat drafts; a send opens one turn's writes, at most twice", () => {
  const allow = scoutJourneyWrites();
  const at = (path) => `https://tomverse.app${path}`;
  assert.equal(allow("PUT", at("/api/products/chat/drafts/new")), true);
  assert.equal(allow("DELETE", at("/api/products/chat/drafts/c1")), true);
  assert.equal(allow("POST", at("/api/chat")), false, "no turn without a send");
  assert.equal(allow("DELETE", at("/api/conversations/c1")), false);
  assert.equal(allow("PATCH", at("/api/user/settings")), false);
  assert.equal(allow.openTurn(), true);
  assert.equal(allow("POST", at("/api/chat")), true);
  assert.equal(allow("POST", at("/api/conversations/c1/image-turn")), true);
  assert.equal(allow("DELETE", at("/api/conversations/c1")), false, "a send still cannot delete");
  allow.closeTurn();
  assert.equal(allow("POST", at("/api/chat")), false);
  assert.equal(allow.openTurn(), true);
  allow.closeTurn();
  assert.equal(allow.openTurn(), false, "the third send is refused");
});

test("the journey is off unless its app switch is set, takes a permit, and the Admin view names it", () => {
  assert.ok(SCOUT_GENERATIONS.some((entry) => entry.id === SCOUT_JOURNEY_GENERATION && entry.switchEnv === SCOUT_JOURNEY_TASK_ENV));
  const all = { generations: SCOUT_GENERATIONS.map((entry) => entry.id) };
  assert.ok(!requestedScoutGenerations(all, {}).includes(SCOUT_JOURNEY_GENERATION));
  assert.ok(requestedScoutGenerations(all, { [SCOUT_JOURNEY_TASK_ENV]: "1" }).includes(SCOUT_JOURNEY_GENERATION));
  assert.deepEqual(scoutSubjectInfo(SCOUT_JOURNEY_GENERATION), { kind: "file", format: "generated-journey" });
});

// ---------------------------------------------------------------- the planner

test("the planner is told the walker's actions, places, controls and files, and steered off earlier findings", () => {
  for (const path of JOURNEY_PATHS) assert.ok(JOURNEY_SYSTEM_PROMPT.includes(path), path);
  for (const anchor of Object.keys(JOURNEY_ANCHORS)) assert.ok(JOURNEY_SYSTEM_PROMPT.includes(`- ${anchor}:`), anchor);
  for (const name of Object.keys(SCOUT_FIXTURES)) assert.ok(JOURNEY_SYSTEM_PROMPT.includes(`- ${name}:`), name);
  assert.match(JOURNEY_SYSTEM_PROMPT, /BETWEEN screens/);
  assert.deepEqual(JOURNEY_OUTPUT_SCHEMA.properties.start.properties.attachments.items.enum, Object.keys(SCOUT_FIXTURES));
  assert.match(journeyPromptText(["초안이 사라짐"], new Date("2026-11-15T18:00:00Z")), /Today is 2026-11-15\.\n<recent>\n- 초안이 사라짐\n<\/recent>/);
  assert.match(SCOUT_SYSTEM_PROMPT, /journey of several steps[^]*vanished after moving away and back[^]*still open after its job was done/);
});

function deps(overrides = {}) {
  const calls = { reserved: [], settled: [], planned: 0 };
  return {
    calls,
    value: {
      now: new Date("2026-11-15T18:00:00Z"),
      recentTitles: async () => ["초안이 사라짐"],
      model: async () => ({
        modelId: "model-a",
        planJourney: async () => {
          calls.planned += 1;
          return { journey, inputTokens: 500, outputTokens: 120 };
        },
      }),
      reserve: async (modelId) => {
        calls.reserved.push(modelId);
        return { id: "call-1" };
      },
      settle: async (id, result) => {
        calls.settled.push({ id, ...result });
      },
      ...overrides,
    },
  };
}

test("today's journey reserves one call and settles it; no model or no room spends nothing", async () => {
  const run = deps();
  assert.deepEqual(await runJourney(run.value), { journey });
  assert.deepEqual(run.calls.settled, [{ id: "call-1", ok: true, inputTokens: 500, outputTokens: 120, kept: 1 }]);
  assert.equal(JOURNEY_SUBJECT, "scenario.journey");

  const off = deps({ model: async () => null });
  assert.deepEqual(await runJourney(off.value), { judged: false, reason: "model_off" });
  assert.deepEqual(off.calls.reserved, []);

  const capped = deps({ reserve: async () => ({ refused: "daily_cap_reached" }) });
  assert.deepEqual(await runJourney(capped.value), { judged: false, reason: "daily_cap_reached" });
  assert.equal(capped.calls.planned, 0);

  const failed = deps({ model: async () => ({ modelId: "m", planJourney: async () => ({ journey: null, inputTokens: 9, outputTokens: null }) }) });
  assert.deepEqual(await runJourney(failed.value), { judged: false, reason: "model_failed" });
  assert.deepEqual(failed.calls.settled, [{ id: "call-1", ok: false, inputTokens: 9, outputTokens: null, kept: 0 }]);
});

test("the journey route keeps a call free for the judge and does not exist until both switches are on", async () => {
  const source = readFileSync(new URL("../app/api/internal/product-research/scout/journey/route.ts", import.meta.url), "utf8");
  assert.match(source, /startScoutCall\(\{ subject: JOURNEY_SUBJECT, modelId, keepFree: JOURNEY_JUDGE_CALLS \}\)/);
  assert.equal(JOURNEY_JUDGE_CALLS, 1);
  const saved = { ...process.env };
  try {
    const { POST } = await import("../app/api/internal/product-research/scout/journey/route.ts");
    const request = (authorization) =>
      new Request("https://tomverse.app/api/internal/product-research/scout/journey", { method: "POST", headers: authorization ? { authorization } : {} });
    const secret = "s".repeat(32);
    process.env.PRODUCT_RESEARCH_SCOUT_INGEST_SECRET = secret;
    delete process.env.PRODUCT_RESEARCH_SCOUT_ENABLED;
    delete process.env[SCOUT_JOURNEY_TASK_ENV];
    assert.equal((await POST(request(`Bearer ${secret}`))).status, 404, "Scout off");
    process.env.PRODUCT_RESEARCH_SCOUT_ENABLED = "1";
    assert.equal((await POST(request(`Bearer ${secret}`))).status, 404, "journey switch off");
    process.env[SCOUT_JOURNEY_TASK_ENV] = "1";
    assert.equal((await POST(request(null))).status, 401);
    assert.equal((await POST(request("Bearer wrong"))).status, 401);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

// ---------------------------------------------------------------- the walk, in a real Chromium

/**
 * A small phone chat with the two defects people found by using Chat on
 * 2026-11-15: picking a conversation leaves the history drawer open, and New chat
 * from another conversation drops the new-chat draft. It also offers a delete
 * that the walker must refuse.
 */
const chatPage = `<!doctype html><html lang="ko"><body>
<button data-testid="mobile-sidebar-open">menu</button>
<div id="drawer" role="dialog" aria-modal="true" hidden>
  <ul data-testid="sidebar-conversation-list"><li data-testid="sidebar-conversation-item" id="row">지난 대화</li></ul>
  <button data-testid="sidebar-new-chat">새 대화</button>
  <button id="delete">삭제</button>
</div>
<div id="out"></div>
<textarea data-testid="chat-textarea"></textarea>
<button data-testid="chat-send-button">send</button>
<script>
const box = document.querySelector('[data-testid="chat-textarea"]');
const drawer = document.getElementById("drawer");
const out = document.getElementById("out");
fetch("/api/products/chat/drafts/new").then((r) => r.json()).then(({ draft }) => { if (draft) box.value = draft.text; });
box.oninput = () => fetch("/api/products/chat/drafts/new", { method: "PUT", body: box.value }).catch(() => {});
document.querySelector('[data-testid="mobile-sidebar-open"]').onclick = () => { drawer.hidden = false; };
document.getElementById("row").onclick = () => { history.pushState(null, "", "/chat/c1"); box.value = ""; };
document.querySelector('[data-testid="sidebar-new-chat"]').onclick = () => { history.pushState(null, "", "/chat"); drawer.hidden = true; box.value = ""; };
document.getElementById("delete").onclick = () => fetch("/api/conversations/c1", { method: "DELETE" }).catch(() => {});
document.querySelector('[data-testid="chat-send-button"]').onclick = async () => {
  const answer = await (await fetch("/api/chat", { method: "POST", body: box.value })).json();
  out.insertAdjacentHTML("beforeend", '<div data-testid="chat-message" data-message-role="assistant">' + answer.text + '<button data-testid="memory-answer-feedback">report</button></div>');
};
</script></body></html>`;

let server;
let origin;
let browser;
let rules;
const seen = [];
let draft = null;

before(async () => {
  server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://fixture");
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: request.method, pathname });
      const json = (status, value) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (pathname === "/chat" || pathname === "/chat/c1") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(chatPage);
      }
      if (pathname === "/api/products/chat/drafts/new") {
        if (request.method === "PUT") {
          const written = body.startsWith("{") ? JSON.parse(body) : { text: body };
          draft = { text: written.text, attachmentReferences: written.attachmentReferences ?? [], revision: (draft?.revision ?? 0) + 1 };
        }
        return json(200, { draft });
      }
      if (pathname === "/api/chat") return json(200, { text: "답변입니다" });
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await launch([]).catch(() => null);
  if (browser) rules = await installCdpRules(browser, [origin]);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

const place = () => ({
  walk: { origin, headers: {} },
  cookie: { name: "next-auth.session-token", value: "fixture-session", url: origin },
});

test("a journey records every step, so a drawer left open and a draft gone reach the model", async (context) => {
  if (!browser) return context.skip("no browser can start here");
  seen.length = 0;
  draft = null;
  const subject = await walkJourney(browser, rules, admitJourney(journey), place());
  assert.equal(subject.subject, SCOUT_JOURNEY_GENERATION);
  const lines = subject.signals.split("\n");
  const step = (n) => lines.find((line) => line.startsWith(`Step ${n}`)) ?? "";
  assert.match(subject.signals, /Before step 0 the new-chat draft holds "보고서 초안"/);
  assert.match(step(0), /at \/chat; composer holds "보고서 초안"/);
  assert.match(step(2), /click "conversation:1": at \/chat\/c1;[^]*1 open dialog\(s\) or drawer\(s\)/, "the drawer stayed open");
  assert.match(step(3), /click "삭제"/);
  assert.match(step(4), /click "new-chat": at \/chat; composer holds ""/, "the draft is gone");
  assert.match(step(6), /send: [^]*1 answer\(s\)[^]*답변입니다/);
  assert.match(subject.signals, /refused these writes[^]*DELETE \/api\/conversations\/c1/);
  assert.ok(!seen.some((request) => request.method === "DELETE"), "the delete never left the browser");
  assert.equal(seen.filter((request) => request.method === "POST" && request.pathname === "/api/chat").length, 1);
  assert.deepEqual(subject.images.map((image) => image.label), ["steps-0-3", "steps-4-6"]);
  assert.equal(rules.allowWrite, null);
});

test("a step that matches nothing is recorded and the journey goes on", async (context) => {
  if (!browser) return context.skip("no browser can start here");
  const subject = await walkJourney(
    browser,
    rules,
    admitJourney({ ...journey, start: { text: "", attachments: [] }, steps: [{ action: "click", value: "없는 버튼" }, { action: "press", value: "Escape" }] }),
    place(),
  );
  assert.match(subject.signals, /Step 1 -- click "없는 버튼", but nothing visible matched it/);
  assert.match(subject.signals, /Step 2 -- press "Escape"/);
  assert.doesNotMatch(subject.signals, /Before step 0/);
});
