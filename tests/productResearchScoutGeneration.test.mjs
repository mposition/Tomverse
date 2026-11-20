import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { installCdpRules, launch, ruledContext } from "../lib/productResearchScoutBrowser.mjs";
import { generateFile, generateImage } from "../lib/productResearchScoutGeneration.mjs";
import { RENDERER_PROBES } from "../lib/productResearchScoutRendererProbes.mjs";
import { admitDocumentSpec } from "../lib/generatedArtifactCore.ts";
import { renderDocumentArtifact } from "../lib/generatedArtifactRenderers.ts";

/**
 * The walker's real file and image turns in a real Chromium, against a small
 * page that does what the chat does: POST the turn, show a card, and download
 * through fetch into a blob. Skipped where no browser can start.
 */

const pdfProbe = RENDERER_PROBES.find((probe) => probe.format === "pdf");
const pdf = Buffer.from(renderDocumentArtifact(admitDocumentSpec(pdfProbe.spec).spec).bytes);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==",
  "base64",
);

const chatPage = `<!doctype html><html lang="ko"><body>
<textarea data-testid="chat-textarea"></textarea>
<div id="tray"></div>
<button data-testid="chat-send-button">send</button>
<div id="out"></div>
<script>
const out = document.getElementById("out");
fetch("/api/background", { method: "POST", body: "on load" }).catch(() => {});
fetch("/api/products/chat/drafts/new").then((response) => response.json()).then(({ draft }) => {
  if (!draft) return;
  document.querySelector('[data-testid="chat-textarea"]').value = draft.text;
  document.getElementById("tray").innerHTML = draft.attachmentReferences.map(() => '<span data-testid="attachment-complete">file</span>').join("");
});
const settle = (text) => {
  out.insertAdjacentHTML("beforeend", '<div data-testid="chat-message" data-message-role="assistant"><span data-testid="assistant-message-model-name">Fixture Model</span>' + text + '</div><button data-testid="memory-answer-feedback">report</button>');
};
document.querySelector('[data-testid="chat-send-button"]').onclick = async () => {
  const prompt = document.querySelector('[data-testid="chat-textarea"]').value;
  if (prompt.includes("STRAYS")) await fetch("/api/chat/voice", { method: "POST", body: "stray" }).catch(() => {});
  const answer = await (await fetch("/api/chat", { method: "POST", body: prompt })).json();
  if (answer.refusal) {
    settle(answer.refusal);
  } else if (answer.failure) {
    out.innerHTML = '<span data-testid="generated-artifact-failure">' + answer.failure + "</span>";
  } else if (answer.artifact) {
    out.innerHTML = '<button data-testid="generated-artifact-download">download</button>';
    out.firstChild.onclick = async () => {
      const blob = await (await fetch("/api/artifacts/" + answer.artifact)).blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "file";
      link.click();
      await fetch("/api/after-the-turn", { method: "POST", body: "late" }).catch(() => {});
    };
  }
};
</script></body></html>`;

let server;
let origin;
let browser;
let rules;
let imageReads = 0;
const seen = [];
let draft = null;
let uploads = 0;

const walkPlace = (extra = {}) => ({
  walk: { origin, headers: { "CF-Access-Client-Id": "fixture-id" } },
  cookie: { name: "next-auth.session-token", value: "fixture-session", url: origin },
  ...extra,
});

before(async () => {
  server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://fixture");
    seen.push({ method: request.method, pathname, cookie: request.headers.cookie ?? "", access: request.headers["cf-access-client-id"] ?? "" });
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (pathname === "/chat") {
        if (!(request.headers.cookie ?? "").includes("fixture-session")) {
          response.writeHead(302, { location: "/auth/signin" });
          return response.end();
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(chatPage);
      }
      if (pathname === "/auth/signin") {
        response.writeHead(200, { "content-type": "text/html" });
        return response.end("<!doctype html><title>sign in</title>");
      }
      if (pathname === "/api/chat" && request.method === "PUT") {
        const { name, mediaType } = JSON.parse(body);
        return json(200, { key: `acct/${name}`, uploadUrl: `${origin}/r2/${name}`, uploadHeaders: { "Content-Type": mediaType } });
      }
      if (pathname.startsWith("/r2/") && request.method === "PUT") {
        seen.at(-1).bytes = Buffer.concat(chunks).byteLength;
        response.writeHead(200);
        return response.end();
      }
      if (pathname === "/api/chat" && request.method === "PATCH") {
        uploads += 1;
        return json(200, { uploadId: `up_${uploads}` });
      }
      if (pathname === "/api/products/chat/drafts/new") {
        if (request.method === "PUT") {
          const written = JSON.parse(body);
          if (written.expectedRevision !== (draft?.revision ?? 0)) return json(409, { currentRevision: draft?.revision ?? 0 });
          draft = { text: written.text, attachmentReferences: written.attachmentReferences, revision: (draft?.revision ?? 0) + 1 };
        }
        return json(200, { scopeKey: "new", draft });
      }
      if (pathname === "/api/chat") {
        // Sending consumes the draft, as the product does.
        if (draft) draft = { ...draft, text: "", attachmentReferences: [] };
        if (body.includes("HANGS")) return;
        if (body.includes("FAILS")) return json(200, { failure: "The file could not be made." });
        if (body.includes("NOTHING")) return json(200, { refusal: "I cannot read attached files in this chat." });
        return json(200, { artifact: body.includes("BROKEN") ? "broken" : "pdf" });
      }
      if (pathname === "/api/artifacts/pdf") {
        response.writeHead(200, { "content-type": "application/pdf" });
        return response.end(pdf);
      }
      if (pathname === "/api/artifacts/broken") return json(404, { error: "gone" });
      if (pathname === "/api/images/generations" && request.method === "POST") {
        if (body.includes("REFUSED")) return json(403, { code: "PLAN_REQUIRED" });
        return json(202, { generationId: body.includes("FAILS") ? "failing" : "image" });
      }
      if (pathname === "/api/images/generations/image") {
        imageReads += 1;
        return json(200, { status: imageReads < 2 ? "running" : "succeeded" });
      }
      if (pathname === "/api/images/generations/failing") return json(200, { status: "failed", publicErrorCode: "PROVIDER_REFUSED" });
      if (pathname === "/api/images/generations/image/download") {
        response.writeHead(200, { "content-type": "image/png" });
        return response.end(png);
      }
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

const needsBrowser = (name, body) =>
  test(name, async (context) => {
    if (!browser) return context.skip("no browser can start here");
    await body();
  });

needsBrowser("a real PDF comes back through the card's download, with its first page and the chat for the model", async () => {
  seen.length = 0;
  const subject = await generateFile(browser, rules, { id: "generated.pdf", prompt: "PDF please" }, walkPlace());
  assert.equal(subject.kind, "file");
  assert.equal(subject.subject, "generated.pdf");
  assert.deepEqual(subject.images.map((image) => image.label), ["chat", "pdf-page-1"]);
  assert.match(subject.signals, /What was asked for: PDF please/);
  assert.match(subject.signals, /status 200/);
  assert.match(subject.signals, /A PDF of \d+ bytes\./);
  assert.ok(seen.some((request) => request.method === "POST" && request.pathname === "/api/chat"), "the turn was sent");
  for (const request of seen) {
    assert.match(request.cookie, /fixture-session/, request.pathname);
    assert.equal(request.access, "fixture-id", request.pathname);
  }
});

needsBrowser("nothing writes outside the turn, or to a path the turn does not make", async () => {
  seen.length = 0;
  const subject = await generateFile(browser, rules, { id: "generated.pdf", prompt: "STRAYS" }, walkPlace());
  const posts = seen.filter((request) => request.method === "POST").map((request) => request.pathname);
  assert.deepEqual(posts, ["/api/chat"], "not on load, not to another route, not after the answer settled");
  assert.match(subject.signals, /refused these writes during the turn[^]*POST \/api\/chat\/voice/);
  assert.equal(rules.allowWrite, null);
});

needsBrowser("POST closes again after the turn, so a later page cannot write", async () => {
  await generateFile(browser, rules, { id: "generated.pdf", prompt: "PDF please" }, walkPlace());
  const context = await ruledContext(browser, { locale: "ko-KR", cookies: [walkPlace().cookie] });
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/chat`);
    const writes = () => seen.filter((request) => request.method !== "GET").length;
    const before = writes();
    const outcome = await page.evaluate(() => fetch("/api/chat", { method: "POST", body: "x" }).then(() => "sent", () => "blocked"));
    assert.equal(outcome, "blocked");
    assert.equal(writes(), before, "the request never reached the server");
  } finally {
    await context.close();
  }
});

needsBrowser("what the model is told when the file failed, never came, or would not download", async () => {
  const failed = await generateFile(browser, rules, { id: "generated.docx", prompt: "FAILS" }, walkPlace());
  assert.match(failed.signals, /The file card shows a failure: The file could not be made\./);
  assert.deepEqual(failed.images.map((image) => image.label), ["chat"]);

  // A declined answer settles at once, with who answered and what it said: no four-minute wait.
  const startedAt = Date.now();
  const declined = await generateFile(browser, rules, { id: "generated.xlsx", prompt: "NOTHING" }, walkPlace());
  assert.ok(Date.now() - startedAt < 30_000);
  assert.match(declined.signals, /The answer finished without a file card: no file was made\./);
  assert.match(declined.signals, /coming from: Fixture Model/);
  assert.match(declined.signals, /I cannot read attached files in this chat\./);

  const hangs = await generateFile(browser, rules, { id: "generated.xlsx", prompt: "HANGS" }, walkPlace({ timeoutMs: 800 }));
  assert.match(hangs.signals, /stopped at the step "wait_for_answer"/);
  assert.match(hangs.signals, /\(timeout\)/);

  const broken = await generateFile(browser, rules, { id: "generated.pptx", prompt: "BROKEN" }, walkPlace());
  assert.match(broken.signals, /answered with status 404/);
});

needsBrowser("attached fixtures go in through the account's draft, and the browser writes only the turn", async () => {
  seen.length = 0;
  const generation = { id: "generated.attachment-pdf", prompt: "NOTHING merge these into one PDF", attachments: ["chart.png", "receipt.jpg"] };
  const subject = await generateFile(browser, rules, generation, walkPlace());
  const writes = seen.filter((request) => request.method !== "GET").map((request) => `${request.method} ${request.pathname}`);
  assert.deepEqual(writes, [
    "PUT /api/chat",
    "PUT /r2/chart.png",
    "PATCH /api/chat",
    "PUT /api/chat",
    "PUT /r2/receipt.jpg",
    "PATCH /api/chat",
    "PUT /api/products/chat/drafts/new",
    "POST /api/chat",
  ]);
  for (const upload of seen.filter((request) => request.pathname.startsWith("/r2/"))) {
    assert.equal(upload.cookie, "", "the session never goes to storage");
    assert.equal(upload.access, "", "nor does the Access token");
    assert.ok(upload.bytes > 100, "the fixture's bytes arrived");
  }
  assert.match(subject.signals, /What was asked for: NOTHING merge these into one PDF/);
  assert.match(subject.signals, /Attached to the message: chart\.png \(a bar chart[^;]*; receipt\.jpg \(a café receipt/);
  assert.match(subject.signals, /no file was made/);
  assert.equal(rules.allowWrite, null);
});

needsBrowser("a fixture the walker does not have stops the turn before anything is sent", async () => {
  seen.length = 0;
  const subject = await generateFile(browser, rules, { id: "generated.explore", prompt: "x", attachments: ["id-card.jpg"] }, walkPlace());
  assert.match(subject.signals, /stopped at the step "attach"[^]*unknown fixture id-card\.jpg/);
  assert.equal(seen.some((request) => request.method !== "GET"), false);
});

needsBrowser("a session the app does not honour asks the model nothing", async () => {
  const place = walkPlace();
  const subject = await generateFile(browser, rules, { id: "generated.pdf", prompt: "x" }, { ...place, cookie: { ...place.cookie, value: "expired" } });
  assert.equal(subject, null);
});

needsBrowser("a real image is polled to its end and read small enough for the model", async () => {
  imageReads = 0;
  seen.length = 0;
  const subject = await generateImage(browser, { id: "generated.image", prompt: "a cup" }, walkPlace({ pollMs: 10 }));
  assert.deepEqual(subject.images.map((image) => [image.label, image.mediaType]), [["generated-image", "image/jpeg"]]);
  assert.match(subject.signals, /Status succeeded/);
  assert.match(subject.signals, /answered with status 200/);
  for (const request of seen) assert.match(request.cookie, /fixture-session/, request.pathname);
});

needsBrowser("a refused image asks the model nothing, and a failed one says the product's code", async () => {
  assert.equal(await generateImage(browser, { id: "generated.image", prompt: "REFUSED" }, walkPlace({ pollMs: 10 })), null);
  const failed = await generateImage(browser, { id: "generated.image", prompt: "FAILS" }, walkPlace({ pollMs: 10 }));
  assert.deepEqual(failed.images, []);
  assert.match(failed.signals, /Status failed/);
  assert.match(failed.signals, /PROVIDER_REFUSED/);
});
