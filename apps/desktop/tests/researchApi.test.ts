import test from "node:test";
import assert from "node:assert/strict";
import { desktopResearchInput, researchCreateInput, researchStep } from "../src/research-contract";
import { createResearchRunner, researchActionFor, researchTransport } from "../src/host/research-api";

type Sent = { path: string; method?: string; body?: object };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fakeSettings(respond: (request: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  let forgotten = 0;
  return {
    sent, get forgotten() { return forgotten; },
    send: async (request: Sent) => { sent.push(request); return respond(request); },
    forget: () => { forgotten++; },
  };
}
const idle = { saveExport: async () => false, chat: { saveQuestion: async () => ({ conversationId: "c_1", sourceUserMessageId: "m_1" }) } };
const run = (extra: Record<string, unknown> = {}) => ({ id: "r_1", engineVersion: 2, conversationId: "c_1", assistantMessageId: uuid(2), status: "running",
  eventSequence: 4, ...extra });

test("the Research IPC names an action and refuses paths, unknown fields and raw plan editing", () => {
  assert.equal(desktopResearchInput.safeParse({ action: "read", runId: "r_1" }).success, true);
  assert.equal(desktopResearchInput.safeParse({ action: "read", runId: "../r" }).success, false);
  assert.equal(desktopResearchInput.safeParse({ action: "read", runId: "r_1", path: "/api/admin" }).success, false);
  assert.equal(desktopResearchInput.safeParse({ action: "fetch", path: "/api/chat/research/runs" }).success, false);
  assert.equal(researchStep.safeParse({ kind: "plan-edit", expectedPlanRevision: 1, plan: {} }).success, false);
  assert.equal(researchStep.safeParse({ kind: "budget", expectedApprovedCredits: 100, approvedCredits: 150 }).success, true);
  assert.equal(researchStep.safeParse({ kind: "budget", expectedApprovedCredits: 100, approvedCredits: 1_000_000 }).success, false);
  assert.equal(researchCreateInput.safeParse({ userMessageId: uuid(1), assistantMessageId: uuid(2), brief: { question: "q" } }).success, false);
  const created = researchCreateInput.parse({ userMessageId: uuid(1), assistantMessageId: uuid(2), brief: { question: "Compare EV tax credits" }, approvedCredits: 400 });
  assert.deepEqual([created.profile, created.autoStart, created.sources], ["standard", false, []]);
});

test("the transport only reaches Research routes and forgets a rejected session", async () => {
  const settings = fakeSettings(() => new Response("{}", { status: 401 }));
  const transport = researchTransport(settings);
  await assert.rejects(transport("/api/chat/research/runs/r_1/../../admin"), /not a Research route/);
  await assert.rejects(transport("/api/admin/users"), /not a Research route/);
  await assert.rejects(transport("/api/chat/research-preview/cancel"), /not a Research route/);
  assert.equal((await transport("/api/chat/research/runs?conversationId=c_1")).status, 401);
  assert.equal(settings.forgotten, 1);
});

test("starting a Deep Research run sends the confirmed maximum and the parsed brief exactly once", async () => {
  const settings = fakeSettings(() => Response.json({ run: run() }, { status: 201 }));
  const runner = createResearchRunner(settings, idle);
  const outcome = await runner({ action: "create", payload: researchCreateInput.parse({
    userMessageId: uuid(1), assistantMessageId: uuid(2), conversationId: "c_1", brief: { question: " What changed in 2026? ", regions: ["kr"] },
    sources: [{ type: "url", url: "https://example.gov/report" }], approvedCredits: 400, locale: "en" }) });
  assert.deepEqual(outcome, { ok: true, value: run() });
  assert.equal(settings.sent.length, 1);
  assert.equal(`${settings.sent[0].method} ${settings.sent[0].path}`, "POST /api/chat/research/runs");
  assert.deepEqual(settings.sent[0].body, {
    conversationId: "c_1", userMessageId: uuid(1), assistantMessageId: uuid(2),
    brief: { question: "What changed in 2026?", deliverable: "report", searchLanguages: [], regions: ["KR"], includeDomains: [], excludeDomains: [], constraints: [] },
    sources: [{ type: "url", url: "https://example.gov/report" }], profile: "standard", approvedCredits: 400, autoStart: false, locale: "en",
  });
});

test("a refused call returns its status and code", async () => {
  const runner = createResearchRunner(fakeSettings(() => Response.json({ code: "RESEARCH_PLAN_REQUIRED" }, { status: 403 })), idle);
  assert.deepEqual(await runner({ action: "offer", profile: "standard" }), { ok: false, status: 403, code: "RESEARCH_PLAN_REQUIRED" });
  const offline = createResearchRunner(fakeSettings(() => { throw new TypeError("network"); }), idle);
  assert.deepEqual(await offline({ action: "runs", conversationId: "c_1" }), { ok: false, status: 0, code: "RESEARCH_UNAVAILABLE" });
});

test("an action whose response is lost is read back and never sent again", async () => {
  const settings = fakeSettings((request) => request.method === "POST" ? Response.json({ code: "RESEARCH_UNAVAILABLE" }, { status: 503 })
    : Response.json({ run: run({ status: "queued", approvedPlanRevision: 2 }) }));
  const runner = createResearchRunner(settings, idle);
  const outcome = await runner({ action: "act", runId: "r_1", step: { kind: "approve", planRevision: 2 } });
  assert.deepEqual(outcome, { ok: true, value: { run: run({ status: "queued", approvedPlanRevision: 2 }), readback: true, error: { status: 503, code: "RESEARCH_UNAVAILABLE" } } });
  assert.deepEqual(settings.sent.map(({ method, path }) => `${method ?? "GET"} ${path}`), [
    "POST /api/chat/research/runs/r_1/approve", "GET /api/chat/research/runs/r_1",
  ]);
  assert.deepEqual(settings.sent[0].body, { planRevision: 2 });
});

test("run steps map to the engine's own action routes and bodies", async () => {
  const settings = fakeSettings(() => Response.json({ run: run() }));
  const runner = createResearchRunner(settings, idle);
  await runner({ action: "act", runId: "r_1", step: { kind: "plan", expectedPlanRevision: 0, feedback: "Narrow to Korea" } });
  await runner({ action: "act", runId: "r_1", step: { kind: "budget", expectedApprovedCredits: 400, approvedCredits: 600 } });
  await runner({ action: "act", runId: "r_1", step: { kind: "scope", expectedInputRevision: 1, addQuestions: ["What about Japan?"] } });
  await runner({ action: "act", runId: "r_1", step: { kind: "revisions", expectedReportRevision: 1, revisionKind: "format", instruction: "Shorter" } });
  await runner({ action: "act", runId: "r_1", step: { kind: "pause" } });
  assert.deepEqual(settings.sent.map(({ path }) => path.replace("/api/chat/research/runs/r_1/", "")), ["plan", "budget", "scope", "revisions", "pause"]);
  assert.deepEqual(settings.sent.map(({ body }) => body), [
    { expectedPlanRevision: 0, feedback: "Narrow to Korea" },
    { expectedApprovedCredits: 400, approvedCredits: 600 },
    { expectedInputRevision: 1, addQuestions: ["What about Japan?"] },
    { expectedReportRevision: 1, kind: "format", instruction: "Shorter" },
    {},
  ]);
  assert.deepEqual(researchActionFor({ kind: "resume" }), { kind: "resume" });
});

test("Research Preview saves the question first, then starts one run for it", async () => {
  const saved: unknown[] = [];
  const settings = fakeSettings(() => Response.json({ run: { id: "p_1", conversationId: "c_9", assistantMessageId: uuid(7), status: "queued" } }, { status: 201 }));
  const runner = createResearchRunner(settings, {
    ...idle, newId: () => uuid(7),
    chat: { saveQuestion: async (input) => { saved.push(input); return { conversationId: "c_9", sourceUserMessageId: "m_9" }; } },
  });
  const outcome = await runner({ action: "previewStart", input: { requestId: uuid(5), modelId: "gpt-6-luna", question: "Who won?", locale: "en" } });
  assert.deepEqual(saved, [{ conversationId: undefined, requestId: uuid(5), question: "Who won?", modelId: "gpt-6-luna" }]);
  assert.deepEqual(outcome.ok && outcome.value, { run: { id: "p_1", conversationId: "c_9", assistantMessageId: uuid(7), status: "queued" }, conversationId: "c_9" });
  assert.deepEqual(settings.sent.map(({ method, path }) => `${method} ${path}`), ["POST /api/chat/research-preview/runs"]);
  assert.deepEqual(settings.sent[0].body, { conversationId: "c_9", sourceUserMessageId: "m_9", assistantMessageId: uuid(7), modelId: "gpt-6-luna", locale: "en" });
});

test("a Preview start with a lost response looks the run up by its identity instead of repeating it", async () => {
  let created = false;
  const settings = fakeSettings((request) => {
    if (request.method === "POST") { created = true; throw new TypeError("connection reset"); }
    return Response.json({ runs: created ? [{ id: "p_1", assistantMessageId: uuid(7), status: "queued" }] : [] });
  });
  const runner = createResearchRunner(settings, { ...idle, newId: () => uuid(7) });
  const found = await runner({ action: "previewStart", input: { requestId: uuid(5), modelId: "gpt-6-luna", question: "Who won?" } });
  assert.deepEqual(found.ok && found.value, { run: { id: "p_1", assistantMessageId: uuid(7), status: "queued" }, conversationId: "c_1" });
  assert.deepEqual(settings.sent.map(({ method, path }) => `${method ?? "GET"} ${path}`), [
    "POST /api/chat/research-preview/runs", `GET /api/chat/research-preview/runs?assistantMessageId=${uuid(7)}`,
  ]);
  created = false;
  const unknown = createResearchRunner(fakeSettings((request) => request.method === "POST" ? Response.json({ code: "RESEARCH_PREVIEW_UNAVAILABLE" }, { status: 409 }) : Response.json({ runs: [] })), idle);
  assert.deepEqual(await unknown({ action: "previewStart", input: { requestId: uuid(5), modelId: "gpt-6-luna", question: "Who won?" } }),
    { ok: false, status: 409, code: "RESEARCH_PREVIEW_UNAVAILABLE", conversationId: "c_1" });
});

test("the Preview offer is a manual-mode question for a new chat and the saved chat otherwise", async () => {
  const settings = fakeSettings(() => Response.json({ offered: true, reason: "ready", estimatedCredits: 12, features: { pageReading: false, durableRuns: true } }));
  const runner = createResearchRunner(settings, idle);
  await runner({ action: "previewOffer", input: { modelId: "gpt-6-luna", question: "Q" } });
  await runner({ action: "previewOffer", input: { conversationId: "c_1", modelId: "gpt-6-luna", question: "Q" } });
  assert.deepEqual(settings.sent.map(({ body }) => body), [
    { modelId: "gpt-6-luna", question: "Q", selectionMode: "manual" }, { conversationId: "c_1", modelId: "gpt-6-luna", question: "Q" },
  ]);
});

test("a Preview run resumes or cancels only through its own routes", async () => {
  const settings = fakeSettings(() => Response.json({ run: { id: "p_1", status: "queued" } }));
  const runner = createResearchRunner(settings, idle);
  await runner({ action: "previewAct", runId: "p_1", step: "cancel" });
  await runner({ action: "previewAct", runId: "p_1", step: "resume" });
  await runner({ action: "previewRead", runId: "p_1" });
  assert.deepEqual(settings.sent.map(({ method, path }) => `${method ?? "GET"} ${path}`), [
    "POST /api/chat/research-preview/runs/p_1/cancel", "POST /api/chat/research-preview/runs/p_1/resume", "GET /api/chat/research-preview/runs/p_1",
  ]);
  assert.equal(desktopResearchInput.safeParse({ action: "previewAct", runId: "p_1", step: "delete" }).success, false);
});

test("an export is saved under the server's file name through the save dialog", async () => {
  const settings = fakeSettings(() => new Response(new Uint8Array([37, 80, 68, 70]), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="research-2026.pdf"' } }));
  let saved: { size: number; name: string; extension: string } | undefined;
  const runner = createResearchRunner(settings, { ...idle, saveExport: async (load) => {
    const file = await load();
    saved = { size: file.bytes.byteLength, name: file.suggestedName, extension: file.extension };
    return true;
  } });
  assert.deepEqual(await runner({ action: "export", runId: "r_1", format: "pdf", revision: 2 }), { ok: true, value: true });
  assert.deepEqual(saved, { size: 4, name: "research-2026.pdf", extension: "pdf" });
  assert.equal(settings.sent[0].path, "/api/chat/research/runs/r_1/export?format=pdf&revision=2");
  const refused = createResearchRunner(fakeSettings(() => new Response("no", { status: 403 })), idle);
  assert.deepEqual(await refused({ action: "export", runId: "r_1", format: "md" }), { ok: false, status: 403, code: "RESEARCH_EXPORT_FAILED" });
});
