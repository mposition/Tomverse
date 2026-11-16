import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { installCdpRules, launch } from "../lib/productResearchScoutBrowser.mjs";
import {
  JOURNEY_ANCHORS,
  JOURNEY_ATTACHES_MAX,
  JOURNEY_PATHS,
  JOURNEY_SENDS_MAX,
  JOURNEY_STEPS_MAX,
  SCOUT_ATTACHMENT_FOLLOW_UP_GENERATION,
  SCOUT_ATTACHMENT_FOLLOW_UP_TASK_ENV,
  SCOUT_FIXTURES,
  SCOUT_GENERATIONS,
  SCOUT_JOURNEY_GENERATION,
  SCOUT_JOURNEY_TASK_ENV,
  admitJourney,
  journeyTask,
  scoutJourneyWrites,
} from "../lib/productResearchScoutBrowserPolicy.mjs";
import { fitSignals, walkJourney } from "../lib/productResearchScoutJourney.mjs";
import {
  JOURNEY_FAMILIES,
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
  assert.deepEqual(admitJourney({ ...journey, steps: [{ action: "attach", value: " chart.png " }] }).steps, [{ action: "attach", value: "chart.png" }]);
  assert.equal(admitJourney({ ...journey, steps: [{ action: "attach", value: "passport.jpg" }] }), null, "only the synthetic files");
  assert.equal(admitJourney({ ...journey, steps: Array(JOURNEY_ATTACHES_MAX + 1).fill({ action: "attach", value: "chart.png" }) }), null);
});

test("files, then new files in the same conversation: a fixed journey behind its own switch", () => {
  const entry = SCOUT_GENERATIONS.find((generation) => generation.id === SCOUT_ATTACHMENT_FOLLOW_UP_GENERATION);
  assert.equal(entry.switchEnv, SCOUT_ATTACHMENT_FOLLOW_UP_TASK_ENV);
  const fixed = admitJourney(entry.journey);
  assert.ok(fixed, "the walker can follow it");
  assert.deepEqual(fixed.start.attachments, ["chart.png", "receipt.jpg"]);
  assert.deepEqual(fixed.steps.map((step) => step.action), ["send", "attach", "attach", "type", "send"]);
  const all = { generations: SCOUT_GENERATIONS.map((generation) => generation.id) };
  assert.ok(!requestedScoutGenerations(all, {}).includes(SCOUT_ATTACHMENT_FOLLOW_UP_GENERATION));
  assert.ok(requestedScoutGenerations(all, { [SCOUT_ATTACHMENT_FOLLOW_UP_TASK_ENV]: "1" }).includes(SCOUT_ATTACHMENT_FOLLOW_UP_GENERATION));
  assert.deepEqual(scoutSubjectInfo(SCOUT_ATTACHMENT_FOLLOW_UP_GENERATION), { kind: "file", format: "generated-attachment-follow-up" });
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
  assert.match(journeyPromptText(["초안이 사라짐"], new Date("2026-11-15T18:00:00Z")), /Today is 2026-11-15\. Today's family is \d\.\n<production>\nnone\n<\/production>\n<recent>\n- 초안이 사라짐\n<\/recent>/);
  assert.match(JOURNEY_SYSTEM_PROMPT, /- attach: /);
  for (const family of JOURNEY_FAMILIES) assert.ok(JOURNEY_SYSTEM_PROMPT.includes(family), family);
  const families = new Set(Array.from({ length: JOURNEY_FAMILIES.length }, (_, day) =>
    /Today's family is (\d)/.exec(journeyPromptText([], new Date(Date.UTC(2026, 10, 15 + day, 18))))[1]));
  assert.equal(families.size, JOURNEY_FAMILIES.length, "every family comes round");
  assert.match(SCOUT_SYSTEM_PROMPT, /later turn that brought new files[^]*could not read or load the files[^]*file card failed/);
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
 * that the walker must refuse. Like the studio, a New task button sits behind the
 * drawer's full-screen backdrop: the walker must use the drawer's own.
 */
const chatPage = `<!doctype html><html lang="ko"><head><style>
#drawer { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); }
#drawer[hidden] { display: none; }
</style></head><body>
<button class="review-new-task" onclick="document.title = 'background clicked'">새 작업</button>
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
box.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); document.querySelector('[data-testid="chat-send-button"]').click(); } };
document.querySelector('[data-testid="mobile-sidebar-open"]').onclick = () => { drawer.hidden = false; };
document.getElementById("row").onclick = () => { history.pushState(null, "", "/chat/c1"); box.value = ""; };
document.querySelector('[data-testid="sidebar-new-chat"]').onclick = () => { history.pushState(null, "", "/chat"); drawer.hidden = true; box.value = ""; };
document.getElementById("delete").onclick = () => fetch("/api/conversations/c1", { method: "DELETE" }).catch(() => {});
document.querySelector('[data-testid="chat-send-button"]').onclick = async () => {
  const answer = await (await fetch("/api/chat", { method: "POST", body: box.value })).json();
  out.insertAdjacentHTML("beforeend", '<div data-testid="chat-message" data-message-role="assistant">' + answer.text + '<button data-testid="memory-answer-feedback">report</button></div>');
};
</script></body></html>`;

/**
 * A second chat page that reproduces the attachment defect of 2026-11-15: two
 * images made into a PDF, then two new images in the same conversation and the
 * same request, answered "the images could not be loaded" with a failed card.
 * Drafts are kept per conversation, as the product keys them.
 */
const chatWithFiles = `<!doctype html><html lang="ko"><body>
<div id="out"></div>
<div id="tray" data-testid="attachment-tray"></div>
<textarea data-testid="chat-textarea"></textarea>
<button data-testid="chat-send-button">send</button>
<script>
const box = document.querySelector('[data-testid="chat-textarea"]');
const tray = document.getElementById("tray");
const scope = () => new URLSearchParams(location.search).get("conversation") || "new";
fetch("/api/products/chat/drafts/" + scope()).then((r) => r.json()).then(({ draft }) => {
  if (!draft) return;
  box.value = draft.text;
  for (const reference of draft.attachmentReferences) tray.insertAdjacentHTML("beforeend", '<span data-testid="attachment-complete">' + reference.uploadId + '</span>');
});
document.querySelector('[data-testid="chat-send-button"]').onclick = async () => {
  const files = tray.children.length;
  const answer = await (await fetch("/api/chat", { method: "POST", body: JSON.stringify({ text: box.value, files }) })).json();
  tray.innerHTML = "";
  box.value = "";
  history.replaceState(null, "", "/chat?conversation=c2");
  const card = answer.ready
    ? '<li data-testid="generated-artifact-card" data-artifact-status="ready"><p data-testid="generated-artifact-filename">documents.pdf</p><span data-testid="generated-artifact-meta">PDF 문서 · 1.2 MB</span> <button data-testid="generated-artifact-download">다운로드</button></li>'
    : '<li data-testid="generated-artifact-card" data-artifact-status="failed"><p data-testid="generated-artifact-filename">신분증.pdf</p><span data-testid="generated-artifact-failure">파일을 만들지 못했습니다.</span></li>';
  document.getElementById("out").insertAdjacentHTML("beforeend", '<div data-testid="chat-message" data-message-role="assistant">' + answer.text + card + '<button data-testid="memory-answer-feedback">report</button></div>');
};
</script></body></html>`;

let server;
let origin;
let browser;
let rules;
const seen = [];
let draft = null;
const drafts = new Map();
let uploads = 0;
let fileTurns = 0;
/** While set, /chat is the page with files and its drafts are kept per conversation. */
let filesMode = false;

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
      if (filesMode && pathname === "/chat") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(chatWithFiles);
      }
      const scoped = /^\/api\/products\/chat\/drafts\/(new|c2)$/.exec(pathname);
      if (filesMode && scoped) {
        if (request.method === "PUT") {
          const written = JSON.parse(body);
          drafts.set(scoped[1], { text: written.text, attachmentReferences: written.attachmentReferences ?? [], revision: (drafts.get(scoped[1])?.revision ?? 0) + 1 });
        }
        return json(200, { draft: drafts.get(scoped[1]) ?? null });
      }
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
      if (pathname.startsWith("/upload/")) return json(200, {});
      if (pathname === "/api/chat" && request.method === "PUT") return json(200, { key: "k", uploadUrl: `${origin}/upload/k`, uploadHeaders: {} });
      if (pathname === "/api/chat" && request.method === "PATCH") return json(200, { uploadId: `u${(uploads += 1)}` });
      if (filesMode && pathname === "/api/chat") {
        const { files } = JSON.parse(body);
        fileTurns += 1;
        return json(200, fileTurns === 1
          ? { text: `첨부해 주신 ${files}장의 이미지를 하나의 PDF로 만들었습니다.`, ready: true }
          : { text: "첨부해 주신 이미지를 읽어오는 과정에서 일시적인 문제가 발생해 파일을 불러오지 못했습니다.", ready: false });
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
  assert.doesNotMatch(step(4), /failed|nothing visible/, "the drawer's own New chat, not the covered one behind it");
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

test("Enter in the composer sends like the send button: counted, written and waited for", async (context) => {
  if (!browser) return context.skip("no browser can start here");
  seen.length = 0;
  const subject = await walkJourney(
    browser,
    rules,
    admitJourney({ ...journey, start: { text: "", attachments: [] }, steps: [{ action: "type", value: "엔터로 보내기" }, { action: "press", value: "Enter" }] }),
    place(),
  );
  assert.match(subject.signals, /Step 2 -- press "Enter", which sent the message: [^]*1 answer\(s\)/);
  assert.equal(seen.filter((request) => request.method === "POST" && request.pathname === "/api/chat").length, 1);
  assert.doesNotMatch(subject.signals, /refused these writes/);
  assert.equal(rules.allowWrite, null);
});

test("new files in a later turn: attached into the conversation's draft, and a failed second card reaches the model", async (context) => {
  if (!browser) return context.skip("no browser can start here");
  seen.length = 0;
  drafts.clear();
  uploads = 0;
  fileTurns = 0;
  filesMode = true;
  context.after(() => {
    filesMode = false;
  });
  const entry = SCOUT_GENERATIONS.find((generation) => generation.id === SCOUT_ATTACHMENT_FOLLOW_UP_GENERATION);
  const subject = await walkJourney(browser, rules, admitJourney(entry.journey), { ...place(), subject: SCOUT_ATTACHMENT_FOLLOW_UP_GENERATION, author: "a fixed regression check" });
  assert.equal(subject.subject, SCOUT_ATTACHMENT_FOLLOW_UP_GENERATION);
  assert.match(subject.signals, /following steps a fixed regression check wrote/);
  const lines = subject.signals.split("\n");
  const step = (n) => lines.find((line) => new RegExp(`^Step ${n}( --|:)`).test(line)) ?? "";
  assert.match(step(0), /at \/chat; composer holds "첨부한 두 이미지를[^]*2 attachment\(s\)/);
  assert.match(step(1), /send: at \/chat; [^]*file cards: answer 1 ready "documents\.pdf PDF 문서 · 1\.2 MB 다운로드"/, "the card's name and kind, not only its button");
  assert.match(step(2), /attach "receipt\.jpg" \(a café receipt[^]*this conversation's draft and reloaded the page[^]*1 attachment\(s\)/);
  assert.match(step(3), /attach "chart\.png"[^]*2 attachment\(s\)/);
  assert.match(step(4), /composer holds "이 두 이미지도 같은 방식으로/);
  // The fixture page shows no history after the walker's reload, so the failed card is on the only answer shown.
  assert.match(step(5), /send: [^]*answer \d failed "신분증\.pdf 파일을 만들지 못했습니다\."[^]*불러오지 못했습니다/);
  assert.equal(seen.filter((request) => request.method === "POST" && request.pathname === "/api/chat").length, 2);
  assert.equal(seen.filter((request) => request.method === "PATCH" && request.pathname === "/api/chat").length, 4, "four files added, each finalised once");
  assert.equal(drafts.get("c2").attachmentReferences.length, 2, "the second turn's files went into the conversation's draft");
  assert.doesNotMatch(subject.signals, /refused these writes/);
  assert.equal(rules.allowWrite, null);
});

test("with answers on screen and no conversation named, an attach step adds nothing rather than guess the draft", async (context) => {
  if (!browser) return context.skip("no browser can start here");
  seen.length = 0;
  const subject = await walkJourney(
    browser,
    rules,
    admitJourney({ ...journey, start: { text: "", attachments: [] }, steps: [{ action: "type", value: "첫 질문" }, { action: "send", value: "" }, { action: "attach", value: "chart.png" }] }),
    place(),
  );
  assert.match(subject.signals, /Step 3 -- attach "chart\.png", but the address names no conversation while answers are on screen, so the walker did not add it/);
  assert.ok(!seen.some((request) => request.method === "PATCH"), "nothing was uploaded");
});

test("a long journey keeps its setup and its latest steps", () => {
  const facts = ["setup line", ...Array.from({ length: 40 }, (_, index) => `Step ${index} ${"x".repeat(150)}`), "The walker's own rule refused these writes: DELETE /api/conversations/c1."];
  const signals = fitSignals(facts);
  assert.ok(signals.length <= 4_000);
  assert.ok(signals.startsWith("setup line"));
  assert.match(signals, /\[earlier steps cut to fit\][^]*Step 39[^]*refused these writes/);
  assert.equal(fitSignals(["a", "b"]), "a\nb");
});
