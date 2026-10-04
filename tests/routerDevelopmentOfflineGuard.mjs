// Preloaded by offline CLI regressions before application imports.
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
const refuse = () => {
  const error = new Error("offline_network_forbidden");
  process.stderr.write(`OFFLINE_NETWORK_ATTEMPT\n${error.stack}\n`);
  throw error;
};
globalThis.fetch = refuse;
// tsx's loader optionally contacts its parent's local IPC pipe. Simulate an absent
// parent without opening that pipe; TCP, HTTP, TLS and fetch stay refused.
// Node 22 net docs distinguish createConnection(path) IPC from port/host TCP.
const pipe = join(tmpdir(), `tsx-${typeof process.geteuid === "function" ? process.geteuid() : userInfo().username}`, `${process.ppid}.pipe`);
const parentPipe = process.platform === "win32" ? `\\\\?\\pipe\\${pipe}` : pipe;
const guardedConnection = (endpoint) => {
  if (endpoint !== parentPipe) return refuse();
  const socket = new EventEmitter();
  socket.unref = () => socket;
  queueMicrotask(() => socket.emit("error", new Error("offline_parent_ipc_absent")));
  return socket;
};
net.connect = guardedConnection;
net.createConnection = guardedConnection;
tls.connect = refuse;
http.request = refuse;
http.get = refuse;
https.request = refuse;
https.get = refuse;
syncBuiltinESMExports();
