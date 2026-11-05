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
<button data-testid="chat-send-button">send</button>
<div id="out"></div>
<script>
const out = document.getElementById("out");
fetch("/api/background", { method: "POST", body: "on load" }).catch(() => {});
document.querySelector('[data-testid="chat-send-button"]').onclick = async () => {
  const prompt = document.querySelector('[data-testid="chat-textarea"]').value;
  if (prompt.includes("STRAYS")) await fetch("/api/chat/voice", { method: "POST", body: "stray" }).catch(() => {});
  const answer = await (await fetch("/api/chat", { method: "POST", body: prompt })).json();
  if (answer.failure) {
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
      if (pathname === "/api/chat") {
        if (body.includes("FAILS")) return json(200, { failure: "The file could not be made." });
        if (body.includes("NOTHING")) return json(200, {});
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
    const before = seen.length;
    const outcome = await page.evaluate(() => fetch("/api/chat", { method: "POST", body: "x" }).then(() => "sent", () => "blocked"));
    assert.equal(outcome, "blocked");
    assert.equal(seen.length, before, "the request never reached the server");
  } finally {
    await context.close();
  }
});

needsBrowser("what the model is told when the file failed, never came, or would not download", async () => {
  const failed = await generateFile(browser, rules, { id: "generated.docx", prompt: "FAILS" }, walkPlace());
  assert.match(failed.signals, /The file card shows a failure: The file could not be made\./);
  assert.deepEqual(failed.images.map((image) => image.label), ["chat"]);

  const nothing = await generateFile(browser, rules, { id: "generated.xlsx", prompt: "NOTHING" }, walkPlace({ timeoutMs: 800 }));
  assert.match(nothing.signals, /stopped at the step "wait_for_file"/);
  assert.match(nothing.signals, /\(timeout\)/);

  const broken = await generateFile(browser, rules, { id: "generated.pptx", prompt: "BROKEN" }, walkPlace());
  assert.match(broken.signals, /answered with status 404/);
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
