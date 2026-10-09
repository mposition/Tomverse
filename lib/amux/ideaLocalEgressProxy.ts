import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";

import { planAmuxV4EgressConnect, planAmuxV4EgressTarget } from "./ideaLocalEgressCore.ts";

export type AmuxV4EgressProxyDeps = {
  /** DNS is resolved outside the network-isolated CLI; never dial by name. */
  resolve?: (host: string) => Promise<string[]>;
  dial?: (address: string, port: 443) => Socket;
  /** Count-only diagnostic; no hostname or request text leaves the proxy. */
  onConnectDecision?: (decision: "approved" | "denied") => void;
};

const MAX_HEAD_BYTES = 4_096;
const MAX_ACTIVE_TUNNELS = 4;
const MAX_PROXY_CONNECTIONS = 16;
const MAX_DIRECTION_BYTES = 16 * 1024 * 1024;
// Equal to the v13 process hard deadline; the process supervisor, not a
// shorter tunnel lifetime, decides whether the one-shot analysis timed out.
const TUNNEL_DEADLINE_MS = 600_000;
const CONNECT_DEADLINE_MS = 5_000;

const refuse = (socket: Socket, status: 403 | 429 | 502) => {
  if (socket.destroyed) return;
  const reason = status === 403 ? "Forbidden" :
    status === 429 ? "Too Many Requests" : "Bad Gateway";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const timer = setTimeout(() => socket.destroy(), 1_000);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
  socket.on("error", () => socket.destroy());
};

/** This is the only egress interface intended for the Bubblewrap network
 * namespace. The supervising process must bind this proxy to a private Unix
 * socket, expose only that socket to the namespace, and provide an approved
 * exact-host catalog. This module does not enable model calls by itself. */
export function createAmuxV4EgressProxy(
  approvedHosts: readonly string[], deps: AmuxV4EgressProxyDeps = {},
) {
  // A running proxy must not inherit later mutations of the owner's catalog.
  const hosts = Object.freeze([...approvedHosts]);
  const resolve = deps.resolve ?? (async (host: string) =>
    (await lookup(host, { all: true, family: 4 })).map((row) => row.address));
  const dial = deps.dial ?? ((address: string, port: 443) =>
    connect({ host: address, port }));
  let active = 0;
  const server = createServer((_request, response) => {
    response.writeHead(405, { "Cache-Control": "no-store", "Content-Length": "0",
      Connection: "close" });
    response.end();
  });
  server.maxConnections = MAX_PROXY_CONNECTIONS;
  server.maxHeadersCount = 16;
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.on("connection", (socket) => {
    socket.setTimeout(5_000, () => socket.destroy());
  });
  server.on("connect", async (request: IncomingMessage, client: Socket, head: Buffer) => {
    client.setTimeout(0);
    client.pause();
    let decided = false;
    const decide = (decision: "approved" | "denied") => {
      if (decided) return;
      decided = true;
      deps.onConnectDecision?.(decision);
    };
    client.once("close", () => decide("denied"));
    if (head.length > MAX_HEAD_BYTES) {
      decide("denied"); refuse(client, 403); return;
    }
    if (active >= MAX_ACTIVE_TUNNELS) {
      decide("denied"); refuse(client, 429); return;
    }
    const target = planAmuxV4EgressTarget({ method: request.method,
      authority: request.url, approvedHosts: hosts });
    if (target.decision !== "target_approved") {
      decide("denied"); refuse(client, 403); return;
    }
    active += 1;
    let released = false;
    const release = () => { if (!released) { released = true; active -= 1; } };
    client.once("close", release);
    client.on("error", () => client.destroy());
    const deadline = setTimeout(() => client.destroy(), TUNNEL_DEADLINE_MS);
    deadline.unref();
    client.once("close", () => clearTimeout(deadline));
    let addresses: string[];
    try {
      addresses = await Promise.race([
        resolve(target.host),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("DNS deadline")), CONNECT_DEADLINE_MS);
          timer.unref();
          client.once("close", () => clearTimeout(timer));
        }),
      ]);
    } catch {
      decide("denied"); refuse(client, 502); return;
    }
    const plan = planAmuxV4EgressConnect({ method: request.method,
      authority: request.url, approvedHosts: hosts,
      resolvedAddresses: addresses });
    if (plan.decision !== "connect_candidate") {
      decide("denied"); refuse(client, 403); return;
    }
    if (client.destroyed) return;
    let upstream: Socket;
    try { upstream = dial(plan.address, plan.port); } catch {
      decide("denied"); refuse(client, 502); return;
    }
    const connectDeadline = setTimeout(() => { client.destroy(); upstream.destroy(); },
      CONNECT_DEADLINE_MS);
    connectDeadline.unref();
    const close = () => {
      clearTimeout(connectDeadline); decide("denied");
      client.destroy(); upstream.destroy();
    };
    client.once("close", close);
    upstream.once("close", close);
    upstream.on("error", close);
    let outbound = head.length;
    let inbound = 0;
    client.on("data", (bytes: Buffer) => {
      outbound += bytes.length;
      if (outbound > MAX_DIRECTION_BYTES) close();
    });
    upstream.on("data", (bytes: Buffer) => {
      inbound += bytes.length;
      if (inbound > MAX_DIRECTION_BYTES) close();
    });
    upstream.once("connect", () => {
      clearTimeout(connectDeadline);
      if (client.destroyed) { close(); return; }
      decide("approved");
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  return server;
}
