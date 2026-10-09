import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createTcpServer, connect as connectTcp } from "node:net";
import test from "node:test";

import {
  isPublicAmuxV4Ipv4,
  planAmuxV4EgressConnect,
  planAmuxV4EgressTarget,
} from "../lib/amux/ideaLocalEgressCore.ts";
import { createAmuxV4EgressProxy } from "../lib/amux/ideaLocalEgressProxy.ts";

const candidate = (changes = {}) => ({
  method: "CONNECT",
  authority: "api.openai.com:443",
  approvedHosts: ["api.openai.com", "api.anthropic.com"],
  resolvedAddresses: ["104.18.6.192"],
  ...changes,
});

test("only an exact approved HTTPS host and public resolved address can be dialed", () => {
  assert.deepEqual(planAmuxV4EgressTarget(candidate()), {
    decision: "target_approved", host: "api.openai.com",
  });
  assert.deepEqual(planAmuxV4EgressConnect(candidate()), {
    decision: "connect_candidate", host: "api.openai.com",
    address: "104.18.6.192", port: 443,
  });
  for (const authority of [
    "api.openai.com:80", "api.openai.com:444", "API.OPENAI.COM:443",
    "api.openai.com.:443", "api.openai.com.evil.test:443",
    "127.0.0.1:443", "[::1]:443", "user@api.openai.com:443",
  ]) {
    assert.deepEqual(planAmuxV4EgressConnect(candidate({ authority })),
      { decision: "hold", reason: "target_refused" });
  }
  assert.deepEqual(planAmuxV4EgressConnect(candidate({ method: "GET" })),
    { decision: "hold", reason: "target_refused" });
});

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve(server.address().port);
  });
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const exchange = (port, request, until) => new Promise((resolve, reject) => {
  const socket = connectTcp({ host: "127.0.0.1", port });
  let output = "";
  const timeout = setTimeout(() => { socket.destroy(); reject(new Error("proxy response deadline")); }, 2_000);
  socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
  socket.on("data", (bytes) => {
    output += bytes.toString("utf8");
    if (output.includes(until)) {
      clearTimeout(timeout);
      socket.destroy();
      resolve(output);
    }
  });
  socket.once("connect", () => socket.write(request));
});

test("proxy rejects unapproved targets before DNS and dials only the checked IP", async () => {
  const echo = createTcpServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo);
  const hosts = ["api.openai.com"];
  const lookedUp = [];
  const dialed = [];
  const decisions = [];
  const proxy = createAmuxV4EgressProxy(hosts, {
    onConnectDecision: (decision) => decisions.push(decision),
    resolve: async (host) => { lookedUp.push(host); return ["104.18.6.192"]; },
    dial: (address, port) => {
      dialed.push([address, port]);
      return connectTcp({ host: "127.0.0.1", port: echoPort });
    },
  });
  const proxyPort = await listen(proxy);
  try {
    hosts.push("evil.example");
    const denied = await exchange(proxyPort,
      "CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n",
      "403 Forbidden");
    assert.match(denied, /403 Forbidden/);
    assert.deepEqual(lookedUp, []);
    assert.deepEqual(dialed, []);

    const allowed = await exchange(proxyPort,
      "CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\nSYNTHETIC",
      "SYNTHETIC");
    assert.match(allowed, /^HTTP\/1\.1 200 Connection Established/);
    assert.deepEqual(lookedUp, ["api.openai.com"]);
    assert.deepEqual(dialed, [["104.18.6.192", 443]]);
    assert.deepEqual(decisions, ["denied", "approved"]);
  } finally {
    await close(proxy);
    await close(echo);
  }
});

test("proxy refuses private DNS answers and never calls its dialer", async () => {
  let dialCount = 0;
  const decisions = [];
  const proxy = createAmuxV4EgressProxy(["api.anthropic.com"], {
    onConnectDecision: (decision) => decisions.push(decision),
    resolve: async () => ["104.18.6.192", "169.254.169.254"],
    dial: () => { dialCount += 1; throw new Error("must not dial"); },
  });
  const proxyPort = await listen(proxy);
  try {
    const denied = await exchange(proxyPort,
      "CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n",
      "403 Forbidden");
    assert.match(denied, /403 Forbidden/);
    assert.equal(dialCount, 0);
    assert.deepEqual(decisions, ["denied"]);
  } finally {
    await close(proxy);
  }
});

test("proxy closes ordinary HTTP, rejects non-443 CONNECT before DNS, and fails closed on dial error", async () => {
  const lookedUp = [];
  const proxy = createAmuxV4EgressProxy(["api.openai.com"], {
    resolve: async (host) => { lookedUp.push(host); return ["104.18.6.192"]; },
    dial: () => { throw new Error("synthetic dial failure"); },
  });
  const proxyPort = await listen(proxy);
  try {
    assert.match(await exchange(proxyPort,
      "GET http://api.openai.com/ HTTP/1.1\r\nHost: api.openai.com\r\n\r\n",
      "405 Method Not Allowed"), /Connection: close/i);
    assert.match(await exchange(proxyPort,
      "CONNECT api.openai.com:80 HTTP/1.1\r\nHost: api.openai.com:80\r\n\r\n",
      "403 Forbidden"), /403 Forbidden/);
    assert.deepEqual(lookedUp, []);
    assert.match(await exchange(proxyPort,
      "CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n",
      "502 Bad Gateway"), /502 Bad Gateway/);
    assert.deepEqual(lookedUp, ["api.openai.com"]);
  } finally {
    await close(proxy);
  }
});

test("proxy caps simultaneous tunnels and releases a slot after disconnect", async () => {
  const echoSockets = [];
  const echo = createTcpServer((socket) => {
    echoSockets.push(socket);
    socket.pipe(socket);
  });
  const echoPort = await listen(echo);
  const proxy = createAmuxV4EgressProxy(["api.openai.com"], {
    resolve: async () => ["104.18.6.192"],
    dial: () => connectTcp({ host: "127.0.0.1", port: echoPort }),
  });
  const proxyPort = await listen(proxy);
  const request = "CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n";
  const sockets = [];
  const openTunnel = () => new Promise((resolve, reject) => {
    const socket = connectTcp({ host: "127.0.0.1", port: proxyPort });
    const fail = (error) => { socket.destroy(); reject(error); };
    socket.once("error", fail);
    socket.once("connect", () => socket.write(request));
    socket.once("data", (bytes) => {
      if (!/200 Connection Established/.test(bytes.toString())) {
        fail(new Error(`unexpected proxy response: ${bytes.toString()}`));
        return;
      }
      socket.off("error", fail);
      resolve(socket);
    });
  });
  try {
    for (let index = 0; index < 4; index += 1) sockets.push(await openTunnel());
    assert.match(await exchange(proxyPort, request, "429 Too Many Requests"),
      /429 Too Many Requests/);
    const closed = once(sockets[0], "close");
    const upstreamClosed = once(echoSockets[0], "close");
    sockets[0].destroy();
    await closed;
    await upstreamClosed;
    sockets.push(await openTunnel());
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(proxy);
    await close(echo);
  }
});

test("a missing, wildcard or malformed owner-approved host list fails closed", () => {
  for (const approvedHosts of [[], ["*.openai.com"], ["api.openai.com."],
    ["API.OPENAI.COM"], ["api.openai.com", "api.openai.com"]]) {
    assert.deepEqual(planAmuxV4EgressConnect(candidate({ approvedHosts })),
      { decision: "hold", reason: "config_invalid" });
  }
});

test("every DNS answer must be public IPv4 and a caller must dial the checked IP", () => {
  for (const address of [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "192.0.2.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "240.0.0.1", "::1",
    "::ffff:127.0.0.1", "0177.0.0.1", "1.1.1.01",
  ]) {
    assert.equal(isPublicAmuxV4Ipv4(address), false, address);
    assert.deepEqual(planAmuxV4EgressConnect(candidate({
      resolvedAddresses: ["104.18.6.192", address],
    })), { decision: "hold", reason: "address_refused" }, address);
  }
  assert.equal(isPublicAmuxV4Ipv4("1.1.1.1"), true);
  assert.deepEqual(planAmuxV4EgressConnect(candidate({ resolvedAddresses: [] })),
    { decision: "hold", reason: "dns_unavailable" });
});
