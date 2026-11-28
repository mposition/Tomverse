import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { expect, type ElectronApplication } from "@playwright/test";
import { FakeGateway, TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { qwenSubscriptionFixtureToken } from "../src/host/cli-fixture-input";
import { launchNativeFixture } from "./launch-native-fixture";

const executable = process.env.TOMVERSE_DESKTOP_QWEN_TASK_BINARY;
const model = "qwen3.8-max";
const taskWait = process.platform === "linux" ? 100_000 : 30_000;

test("Qwen Code pauses for its subscription quota and restores the reported evidence", {
  timeout: 5 * taskWait, skip: !executable,
}, async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "tomverse-qwen-subscription-")));
  const project = join(temp, "project"), profile = join(temp, "profile"), descriptor = join(temp, "fixture.json");
  const ca = join(temp, "ca.pem"), key = join(temp, "key.pem");
  const requestId = "qwen-subscription-fixture";
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const faults = [
    { title: "Report a Qwen billing error", http: 402, code: "payment_required", expected: "failed" },
    { title: "Report a Qwen permission error", http: 403, code: "permission_error", expected: "failed" },
    { title: "Pause for the Qwen subscription limit", http: 402, code: "insufficient_quota", resetAt, expected: "blocked" },
  ] as const;
  let fault: (typeof faults)[number] = faults[0];
  let app: ElectronApplication | undefined;
  let nativeRequests = 0;
  const gateway = new FakeGateway({ script: () => ({ text: "An unexpected fallback ran." }) });
  const sockets = new Set<Duplex>();
  const proxy = createServer((_request, response) => response.writeHead(403).end());
  const endpoint = createTlsServer();
  try {
    await Promise.all([mkdir(project), mkdir(profile), gateway.start(),
      promisify(execFile)(process.env.TOMVERSE_DESKTOP_TEST_OPENSSL || "openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
        "-subj", "/CN=Local Qwen subscription QA", "-addext", "subjectAltName=DNS:api.qwen.ai",
        "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", key, "-out", ca,
      ]),
    ]);
    endpoint.setSecureContext({ key: await readFile(key), cert: await readFile(ca) });
    endpoint.on("request", (request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("connection", "close");
      request.resume();
      if (request.headers.authorization === `Bearer ${qwenSubscriptionFixtureToken}`) {
        if (request.method === "GET" && request.url === "/compatible-mode/v1/models") {
          return response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model", created: 1, owned_by: "qwen" }] }));
        }
        if (request.method === "POST" && request.url === "/compatible-mode/v1/chat/completions") {
          nativeRequests++;
          return response.writeHead(fault.http, { "x-request-id": requestId }).end(JSON.stringify({ error: {
            code: fault.code, message: fault.title,
            ...("resetAt" in fault && { quota: { member_type: "plus", reset_at: fault.resetAt } }),
          } }));
        }
      }
      return response.writeHead(403).end();
    });
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    // The tunnel terminates at the loopback test server for every connection it accepts.
    proxy.on("connect", (request, socket, head) => {
      if (request.url !== "api.qwen.ai:443") return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      sockets.add(socket);
      const peer = connect(address.port, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) peer.write(head);
        peer.pipe(socket);
        socket.pipe(peer);
      });
      peer.on("error", () => socket.destroy());
      socket.on("error", () => peer.destroy());
      socket.once("close", () => { sockets.delete(socket); peer.destroy(); });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress !== "string");
    await writeFile(join(profile, "language.txt"), "en");
    await writeFile(descriptor, JSON.stringify({ root: project, profile, endpoint: gateway.base, key: TEST_KEY, qwen: {
      executable, version: "0.28.4", model, origin: `http://127.0.0.1:${proxyAddress.port}`, subscriptionCa: ca, allowSavedHistory: true,
    } }));
    app = await launchNativeFixture(descriptor);
    const page = await app.firstWindow();
    const snapshot = () => page.evaluate(() => window.desktop.state());
    await page.getByRole("button", { name: "Open local folder" }).click();
    await expect.poll(async () => (await snapshot()).models.some(({ id }) => id === "fake-coder"), { timeout: taskWait }).toBe(true);
    await page.evaluate(async () => {
      await window.desktop.setCodeExecutionPreference("provider_cli");
      const scope = (await window.desktop.state()).codeFallback!.scope;
      await window.desktop.updateCodeFallback({ scope, field: "destination", engine: "tomverse_api" });
      await window.desktop.updateCodeFallback({ scope, field: "model", model: "fake-coder" });
      await window.desktop.updateCodeFallback({ scope, field: "apiCreditCap", credits: 50 });
      await window.desktop.updateCodeFallback({ scope, field: "automatic", enabled: true });
    });
    assert.equal((await snapshot()).codeFallback?.settings.automaticFrom, "provider_cli");

    const quota = page.getByRole("region", { name: "Code paused at a usage limit" });
    for (const scenario of faults) {
      fault = scenario;
      const before = nativeRequests;
      await page.getByLabel("Code mode").selectOption("ask");
      await page.getByRole("checkbox", { name: "Save to local history" }).check();
      await page.getByRole("textbox", { name: "Code request" }).fill(scenario.title);
      await page.getByRole("button", { name: "Send Code request", exact: true }).click();
      await expect.poll(async () => {
        const task = (await snapshot()).task;
        return [task?.title, task?.status];
      }, { timeout: taskWait }).toEqual([scenario.title, scenario.expected]);
      assert.ok(nativeRequests > before);
      if (scenario.expected === "failed") {
        await expect(quota).toHaveCount(0);
        assert.equal((await snapshot()).task?.quota, undefined);
      }
    }
    const saved = (await snapshot()).task;
    assert.ok(saved?.nativeSession);
    assert.deepEqual(saved.quota, { source: "qwen_code", reason: "qwenSubscriptionUsageExhausted", requestId,
      resetAt: new Date(resetAt * 1000).toISOString(), threadId: saved.nativeSession.threadId, turnId: saved.nativeSession.turnId });
    assert.equal(saved.continuation, undefined);
    assert.equal(saved.canResumeAfterQuota, false);
    await expect(quota).toContainText("Qwen Code reported that its subscription usage is exhausted.");
    await expect(quota).toContainText("Reported reset");
    await expect(quota).toContainText("Remaining allowance unconfirmed");
    await expect(quota).toContainText("Overage unconfirmed");

    await app.close();
    app = await launchNativeFixture(descriptor);
    const restored = await app.firstWindow();
    await restored.getByRole("button", { name: "Open local folder" }).click();
    await restored.getByRole("complementary", { name: "History" }).getByRole("button", { name: saved.title, exact: true }).click();
    await expect.poll(async () => (await restored.evaluate(() => window.desktop.state())).task?.id).toBe(saved.id);
    const task = (await restored.evaluate(() => window.desktop.state())).task;
    assert.equal(task?.status, "blocked");
    assert.deepEqual(task?.quota, saved.quota);
    assert.deepEqual(task?.nativeSession, saved.nativeSession);
    assert.equal(gateway.completions.length, 0);
  } finally {
    await app?.close();
    for (const socket of sockets) socket.destroy();
    for (const server of [proxy, endpoint]) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await gateway.stop();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});
