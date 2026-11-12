import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { PDFDocument } from "pdf-lib";

import {
  officeRendererConfig,
  officeRenderingEnabled,
  renderOfficeDocumentToPdf,
} from "../lib/officeRenderer.ts";

// docs/policy/generated-artifacts.md section 15.
//
// The renderer is Gotenberg on the private network. These tests stand a small
// HTTP server in for it, so what is pinned is this client's side of the
// contract: what it sends, and how it reads every answer it can get back.

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const onePagePdf = async () => {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  return Buffer.from(await document.save());
};

/** A stand-in renderer. `respond` decides each answer; requests are kept. */
const standIn = async (respond) => {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      await respond(request, response, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    requests,
    config: (extra = {}) =>
      officeRendererConfig({
        CHAT_OFFICE_TO_PDF: "on",
        OFFICE_RENDERER_URL: `http://127.0.0.1:${port}`,
        ...extra,
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
};

test("office rendering is off unless both the switch and an address are set", () => {
  assert.equal(officeRenderingEnabled({}), false);
  assert.equal(officeRenderingEnabled({ CHAT_OFFICE_TO_PDF: "on" }), false);
  assert.equal(
    officeRenderingEnabled({ OFFICE_RENDERER_URL: "http://gotenberg.railway.internal:3000" }),
    false
  );
  assert.equal(
    officeRenderingEnabled({
      CHAT_OFFICE_TO_PDF: "on",
      OFFICE_RENDERER_URL: "http://gotenberg.railway.internal:3000",
    }),
    true
  );
});

test("a plain-http address must be private, and no address may carry credentials", () => {
  const config = (url) => officeRendererConfig({ CHAT_OFFICE_TO_PDF: "on", OFFICE_RENDERER_URL: url });
  assert.equal(config("http://renderer.example.com"), null);
  assert.equal(config("ftp://gotenberg.railway.internal"), null);
  assert.equal(config("not a url"), null);
  assert.equal(config("https://user:pass@renderer.example.com"), null);
  assert.ok(config("http://gotenberg.railway.internal:3000"));
  assert.ok(config("http://localhost:3000"));
  assert.ok(config("https://renderer.example.com"));
});

test("a rendered document comes back as the PDF, sent under a name of our choosing", async () => {
  const pdf = await onePagePdf();
  const server = await standIn((request, response) => {
    response.writeHead(200, { "content-type": "application/pdf" });
    response.end(pdf);
  });
  try {
    const result = await renderOfficeDocumentToPdf(
      server.config({ OFFICE_RENDERER_USERNAME: "tomverse", OFFICE_RENDERER_PASSWORD: "s3cret" }),
      { mediaType: DOCX, bytes: new Uint8Array([1, 2, 3]) }
    );
    assert.equal(result.ok, true);
    assert.equal((await PDFDocument.load(result.pdf)).getPageCount(), 1);

    const [request] = server.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/forms/libreoffice/convert");
    assert.equal(
      request.headers.authorization,
      `Basic ${Buffer.from("tomverse:s3cret").toString("base64")}`
    );
    const body = request.body.toString("latin1");
    // The extension comes from the stored media type; the user's file name
    // never reaches the renderer's multipart header.
    assert.match(body, /name="files"; filename="document\.docx"/);
  } finally {
    await server.close();
  }
});

test("every answer the renderer can give is read as the failure it is", async () => {
  const cases = [
    [400, "text/plain", "LibreOffice rejected the document", "UNREADABLE"],
    [503, "text/plain", "timeout", "TIMEOUT"],
    [401, "text/plain", "unauthorized", "UNAVAILABLE"],
    [500, "text/plain", "boom", "UNAVAILABLE"],
    [200, "text/html", "<html>proxy page</html>", "UNAVAILABLE"],
  ];
  for (const [status, type, body, failure] of cases) {
    const server = await standIn((request, response) => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    });
    try {
      const result = await renderOfficeDocumentToPdf(server.config(), {
        mediaType: DOCX,
        bytes: new Uint8Array([1]),
      });
      assert.deepEqual(result, { ok: false, failure }, `${status} ${type}`);
    } finally {
      await server.close();
    }
  }
});

test("a renderer that does not answer in time is a timeout, and an unknown type is refused before sending", async () => {
  const server = await standIn(() => {
    // Never answers.
  });
  try {
    const config = { ...server.config(), timeoutMs: 200 };
    const result = await renderOfficeDocumentToPdf(config, { mediaType: DOCX, bytes: new Uint8Array([1]) });
    assert.deepEqual(result, { ok: false, failure: "TIMEOUT" });

    const unknown = await renderOfficeDocumentToPdf(config, {
      mediaType: "application/x-msdownload",
      bytes: new Uint8Array([1]),
    });
    assert.deepEqual(unknown, { ok: false, failure: "UNREADABLE" });
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("a renderer down altogether is unavailable, not a crash", async () => {
  const config = officeRendererConfig({
    CHAT_OFFICE_TO_PDF: "on",
    OFFICE_RENDERER_URL: "http://127.0.0.1:9",
  });
  const result = await renderOfficeDocumentToPdf(config, { mediaType: DOCX, bytes: new Uint8Array([1]) });
  assert.deepEqual(result, { ok: false, failure: "UNAVAILABLE" });
});
