import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { desktopDriveLink, driveAbandonRequest, driveCallbackUrl } from "../../../lib/desktopDrivePickerContract";
import { DriveSelectionTimeout, selectDriveFiles } from "../src/host/drive-picker";

/** Starts a selection against a fake system browser that only records where it was sent. */
function start(options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  let opened!: (url: URL) => void;
  const request = new Promise<URL>((resolve) => { opened = resolve; });
  const selection = selectDriveFiles({
    origin: "https://tomverse.example", language: "en", slots: 3, signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs, openExternal: async (href) => { opened(new URL(href)); },
  });
  void selection.catch(() => {});
  return { selection, link: request.then((url) => {
    const parsed = desktopDriveLink.parse(Object.fromEntries(new URLSearchParams(url.hash.slice(1))));
    return { page: url, port: parsed.port, state: parsed.state };
  }) };
}

test("The picker page that the system browser opens carries the loopback port and a state for this request", async () => {
  const { selection, link } = start();
  const { page, port, state } = await link;
  assert.equal(page.origin + page.pathname, "https://tomverse.example/auth/desktop/drive-picker");
  assert.equal(page.search, "?lang=en");
  assert.ok(port >= 1024 && state.length === 43);
  await fetch(driveCallbackUrl({ port, state }));
  assert.equal(await selection, null);
});

test("A state-only callback, which is what the page sends when its window is closed, ends the wait with no selection", async () => {
  const { selection, link } = start();
  const { port, state } = await link;
  const { url, init } = driveAbandonRequest({ port, state });
  const answer = await fetch(url, init);
  assert.equal(answer.status, 200);
  assert.equal(await selection, null);
});

test("A closing signal with another state is refused and the wait goes on until the real one arrives", async () => {
  const { selection, link } = start();
  const { port, state } = await link;
  let settled = false;
  void selection.then(() => { settled = true; }, () => { settled = true; });
  for (const forged of ["A".repeat(43), "short", "A".repeat(42) + "!", ""]) {
    const answer = await fetch(driveCallbackUrl({ port, state: forged }));
    assert.equal(answer.status, 400, `state ${JSON.stringify(forged)}`);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/desktop-drive/callback`)).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/desktop-drive/other?state=${state}`)).status, 404);
  assert.equal((await fetch(driveCallbackUrl({ port, state }), { method: "POST" })).status, 404);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "no forged or malformed request ended the wait");
  await fetch(driveCallbackUrl({ port, state }));
  assert.equal(await selection, null);
});

test("Anything beyond the state that is not a full encrypted selection does not count as a cancel", async () => {
  const { selection, link } = start();
  const { port, state } = await link;
  const answer = await fetch(driveCallbackUrl({ port, state }).href + "&extra=1");
  assert.equal(answer.status, 400);
  await fetch(driveCallbackUrl({ port, state }));
  assert.equal(await selection, null);
});

test("A second closing signal after the first never reopens the wait", async () => {
  const { selection, link } = start();
  const { port, state } = await link;
  const url = driveCallbackUrl({ port, state });
  assert.equal((await fetch(url)).status, 200);
  assert.equal(await selection, null);
  // The server is closed once the wait ends, so the repeat meets a closed port or a 410.
  const repeat = await fetch(url).then((answer) => answer.status, () => "closed");
  assert.ok(repeat === 410 || repeat === "closed");
});

test("Aborting the request ends the wait with the abort and frees the port", async () => {
  const controller = new AbortController();
  const { selection, link } = start({ signal: controller.signal });
  const { port, state } = await link;
  const reason = new Error("The person cancelled the attachment.");
  controller.abort(reason);
  await assert.rejects(selection, (error) => error === reason);
  await assert.rejects(fetch(driveCallbackUrl({ port, state })));
});

test("An already aborted request never opens the system browser", async () => {
  const controller = new AbortController();
  controller.abort();
  let opened = false;
  await assert.rejects(selectDriveFiles({
    origin: "https://tomverse.example", language: "en", slots: 1, signal: controller.signal, openExternal: async () => { opened = true; },
  }));
  assert.equal(opened, false);
});

test("Leaving the picker window open past the time limit ends the wait as a timeout, not as a cancel", async () => {
  const { selection, link } = start({ timeoutMs: 80 });
  const { port, state } = await link;
  await assert.rejects(selection, DriveSelectionTimeout);
  await assert.rejects(fetch(driveCallbackUrl({ port, state })));
});

test("The picker page sends a closing signal only when the window goes away without using the callback itself", () => {
  const page = readFileSync(fileURLToPath(new URL("../../../app/(site)/auth/desktop/drive-picker/DrivePickerPage.tsx", import.meta.url)), "utf8");
  assert.match(page, /addEventListener\("pagehide", abandon\)/);
  assert.match(page, /driveAbandonRequest\(\{ port, state \}\)/);
  assert.match(page, /function leave\(url: URL\) \{\s*settled\.current = true;\s*window\.location\.replace\(url\.href\);/);
  assert.equal(page.match(/window\.location\.replace/g)?.length, 1, "every way out of the page goes through leave()");
  assert.match(page, /if \(settled\.current\) return;/);
});

test("The closing signal is a credential-free, state-only request that survives the page closing", () => {
  const { url, init } = driveAbandonRequest({ port: 51234, state: "S".repeat(43) });
  const parsed = new URL(url);
  assert.equal(parsed.origin, "http://127.0.0.1:51234");
  assert.equal(parsed.pathname, "/desktop-drive/callback");
  assert.deepEqual([...parsed.searchParams.keys()], ["state"]);
  assert.equal(init.keepalive, true);
  assert.equal(init.credentials, "omit");
  assert.equal(init.referrerPolicy, "no-referrer");
});
