"use strict";

const http = require("node:http");
const http2 = require("node:http2");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");

const BLOCKED_CODE = "QA_EXTERNAL_NETWORK_BLOCKED";

function blocked(target) {
  const error = new Error(`${BLOCKED_CODE}: outbound network is disabled for Playwright (${target})`);
  error.code = BLOCKED_CODE;
  return error;
}

function hostname(value) {
  if (value === undefined || value === null || value === "") {
    return "localhost";
  }

  let host = String(value).trim().toLowerCase();
  if (host.startsWith("[")) {
    const closingBracket = host.indexOf("]");
    return closingBracket === -1 ? host : host.slice(1, closingBracket);
  }

  const firstColon = host.indexOf(":");
  if (firstColon !== -1 && firstColon === host.lastIndexOf(":")) {
    host = host.slice(0, firstColon);
  }

  return host.replace(/\.$/, "");
}

function isLoopback(value) {
  const host = hostname(value);
  return (
    host === "localhost" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("::ffff:127.")
  );
}

function assertLoopback(value, target = value) {
  if (!isLoopback(value)) {
    throw blocked(target ?? "unknown target");
  }
}

function urlHost(value) {
  if (typeof value !== "string" && !(value instanceof URL)) {
    return undefined;
  }

  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function requestHost(input, options) {
  return (
    urlHost(input) ??
    input?.hostname ??
    input?.host ??
    options?.hostname ??
    options?.host ??
    "localhost"
  );
}

function connectionHost(args) {
  const [first, second] = args;

  if (typeof first === "string") {
    return undefined; // A string-only net.connect call targets a local pipe.
  }

  if (typeof first === "number") {
    return typeof second === "string" ? second : "localhost";
  }

  if (first && typeof first === "object") {
    return first.path ? undefined : first.host ?? first.hostname ?? "localhost";
  }

  return "localhost";
}

function assertConnectionAllowed(args) {
  const host = connectionHost(args);
  if (host !== undefined) {
    assertLoopback(host, host);
  }
}

function patchConnection(module, method) {
  const original = module[method];
  module[method] = function guardedConnection(...args) {
    assertConnectionAllowed(args);
    return Reflect.apply(original, this, args);
  };
}

patchConnection(net, "connect");
patchConnection(net, "createConnection");
patchConnection(tls, "connect");

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(...args) {
  assertConnectionAllowed(args);
  return Reflect.apply(originalSocketConnect, this, args);
};

function patchHttp(module) {
  const originalRequest = module.request;
  module.request = function guardedRequest(input, options, ...rest) {
    const host = requestHost(input, options);
    assertLoopback(host, host);
    return Reflect.apply(originalRequest, this, [input, options, ...rest]);
  };

  module.get = function guardedGet(...args) {
    const request = module.request(...args);
    request.end();
    return request;
  };
}

patchHttp(http);
patchHttp(https);

const originalHttp2Connect = http2.connect;
http2.connect = function guardedHttp2Connect(authority, ...args) {
  const host = urlHost(authority) ?? authority?.hostname ?? authority?.host;
  assertLoopback(host, String(authority));
  return Reflect.apply(originalHttp2Connect, this, [authority, ...args]);
};

if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, ...args) {
    const target = input instanceof Request ? input.url : input;
    const host = urlHost(target);
    assertLoopback(host, String(target));
    return Reflect.apply(originalFetch, this, [input, ...args]);
  };
}
