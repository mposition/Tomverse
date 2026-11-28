import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import test from "node:test";
import { startZCodeFixtureProxy } from "../src/host/zcode-fixture";

test("the ZCode fixture tunnels only its own model and tool endpoints", async () => {
  const abort = new AbortController();
  let unintended = 0;
  const model = createServer((_, response) => response.end("model response"));
  const tools = createServer((_, response) => response.end("tool response"));
  const other = createServer((_, response) => { unintended++; response.end(); });
  const endpoints = [model, tools, other];
  let proxy: Awaited<ReturnType<typeof startZCodeFixtureProxy>> | undefined;
  try {
    const origins = await Promise.all(endpoints.map(async (endpoint) => {
      endpoint.listen(0, "127.0.0.1");
      await once(endpoint, "listening");
      const address = endpoint.address();
      assert.ok(address && typeof address !== "string");
      return "http://127.0.0.1:" + address.port;
    }));
    proxy = await startZCodeFixtureProxy(origins[0]!, origins[1]! + "/mcp", abort.signal);
    const tunnel = (destination: string) => new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const client = request(proxy!.origin, { method: "CONNECT", path: destination, signal: AbortSignal.timeout(2000) });
      client.on("error", reject);
      client.once("connect", (response, socket) => {
        socket.once("error", reject);
        if (response.statusCode !== 200) {
          socket.destroy();
          resolve({ status: response.statusCode, body: "" });
          return;
        }
        const chunks: Buffer[] = [];
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8").split("\r\n\r\n")[1] ?? "" }));
        socket.write("GET / HTTP/1.0\r\nHost: " + destination + "\r\n\r\n");
      });
      client.end();
    });
    assert.deepEqual(await tunnel(new URL(origins[0]!).host), { status: 200, body: "model response" });
    assert.deepEqual(await tunnel(new URL(origins[1]!).host), { status: 200, body: "tool response" });
    assert.deepEqual(await tunnel(new URL(origins[2]!).host), { status: 403, body: "" });
    assert.deepEqual(await tunnel("example.invalid:443"), { status: 403, body: "" });
    assert.equal(unintended, 0);
  } finally {
    abort.abort();
    await proxy?.close();
    await Promise.all(endpoints.map((endpoint) => new Promise<void>((resolve) => endpoint.close(() => resolve()))));
  }
});
