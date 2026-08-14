// What an unread response body costs on the server side, measured rather than
// assumed.
//
//   npm run report:unread-body-connection-cost
//
// The browser measurement recorded in lib/apiCacheControlPolicy.ts says nothing
// about this half. Server-side calls go through Node's built-in fetch, which is
// undici, and the concern there is a connection pool, not a cache entry.
//
// Two clients, deliberately kept apart:
//
//   * `globalThis.fetch` is what the application calls, and it is Node's
//     *bundled* undici (process.versions.undici), not the npm package. Its
//     global dispatcher cannot be replaced from outside, so the sections using
//     it measure the pool production actually has: the default one.
//   * the npm `undici` in node_modules is a different copy at a different
//     version, used only where the question needs a *bounded* pool. Every such
//     line says so.
//
// Each case gets its own server on its own port. A port is an origin and an
// origin is a pool, so this is also how each case gets a pool with no history:
// sharing one server made `sockets=0` mean "reused the previous case's
// connections" while reading as "opened none".
//
// The server is a throwaway `node:http` listener in this file. Nothing here
// touches the application: no route is added, no fixture is registered.

import http from "node:http";
import {
  Agent,
  fetch as undiciFetch,
} from "undici";

const KIB = 1024;
const SIZES = [
  ["64B", 64],
  ["16KiB", 16 * KIB],
  ["64KiB", 64 * KIB],
  ["256KiB", 256 * KIB],
  ["2MiB", 2048 * KIB],
];
const CASE_TIMEOUT_MS = 5_000;

/** A fresh server, and therefore a fresh origin and a fresh pool, per case. */
async function withServer(run) {
  let connections = 0;
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const size = Number(url.searchParams.get("size") || 64);
    response.writeHead(Number(url.searchParams.get("status") || 200), {
      "Content-Type": "application/json",
      "Content-Length": String(size),
    });
    response.end(Buffer.alloc(size, 0x61));
  });
  server.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await run({ port, opened: () => connections });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

const CONSUMERS = {
  unread: async () => {
    // Deliberately nothing. This is the shape the report flags.
  },
  drain: async (response) => {
    await response.text();
  },
  cancel: async (response) => {
    await response.body?.cancel();
  },
};

/** Runs work with a deadline, so a starved pool reports instead of hanging. */
async function bounded(work) {
  let timer;
  const outcome = await Promise.race([
    work(),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("STARVED"), CASE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  return outcome;
}

const pad = (value, width) => String(value).padStart(width);

// ---------------------------------------------------------------------------

console.log(
  `Node ${process.version} | bundled undici ${process.versions.undici} ` +
    `= globalThis.fetch | npm undici 7.29.0 = bounded-pool sections\n` +
    `One throwaway server per case, so every pool starts with no history.\n`
);

console.log("A. 5 SEQUENTIAL requests, globalThis.fetch (production's client and pool)");
console.log("   1 socket = the connection was reused all five times.\n");
for (const [sizeLabel, size] of SIZES) {
  for (const status of [200, 500]) {
    const line = [];
    for (const consumer of ["unread", "drain", "cancel"]) {
      const result = await withServer(async ({ port, opened }) => {
        const started = Date.now();
        const outcome = await bounded(async () => {
          for (let i = 0; i < 5; i += 1) {
            const response = await fetch(
              `http://127.0.0.1:${port}/?status=${status}&size=${size}`
            );
            await CONSUMERS[consumer](response);
          }
          return "ok";
        });
        return { outcome, sockets: opened(), elapsed: Date.now() - started };
      });
      line.push(
        `${consumer}=${result.outcome === "ok" ? pad(result.sockets, 2) : "ST"}` +
          `/${pad(result.elapsed, 4)}ms`
      );
    }
    console.log(`  ${sizeLabel.padEnd(7)} ${status}   ${line.join("   ")}`);
  }
}

console.log("\nB. 20 CONCURRENT, globalThis.fetch, production's default pool, status 500");
console.log("   headers-first: await all 20 responses, then consume each body.");
console.log("   streamed:      consume each body as its own response arrives.\n");
for (const [sizeLabel, size] of SIZES) {
  const line = [];
  for (const consumer of ["unread", "drain", "cancel"]) {
    for (const shape of ["headersFirst", "streamed"]) {
      const result = await withServer(async ({ port, opened }) => {
        const url = `http://127.0.0.1:${port}/?status=500&size=${size}`;
        const started = Date.now();
        const outcome = await bounded(async () => {
          if (shape === "headersFirst") {
            const responses = await Promise.all(
              Array.from({ length: 20 }, () => fetch(url))
            );
            await Promise.all(responses.map((r) => CONSUMERS[consumer](r)));
          } else {
            await Promise.all(
              Array.from({ length: 20 }, () =>
                fetch(url).then((r) => CONSUMERS[consumer](r))
              )
            );
          }
          return "ok";
        });
        return { outcome, sockets: opened(), elapsed: Date.now() - started };
      });
      if (shape === "headersFirst") {
        line.push(
          `${consumer}: hdr1st=${
            result.outcome === "ok" ? `${pad(result.sockets, 2)}s/${pad(result.elapsed, 4)}ms` : "STARVED"
          }`
        );
      } else {
        line[line.length - 1] +=
          ` stream=${
            result.outcome === "ok" ? `${pad(result.sockets, 2)}s/${pad(result.elapsed, 4)}ms` : "STARVED"
          }`;
      }
    }
  }
  console.log(`  ${sizeLabel.padEnd(7)}`);
  for (const entry of line) console.log(`      ${entry}`);
}

console.log("\nC. 20 CONCURRENT, npm undici, pool bounded to 4, status 500");
console.log("   The pool production does NOT have -- this is what a cap would do.\n");
for (const [sizeLabel, size] of SIZES) {
  const line = [];
  for (const consumer of ["unread", "drain", "cancel"]) {
    for (const shape of ["headersFirst", "streamed"]) {
      const result = await withServer(async ({ port, opened }) => {
        const agent = new Agent({ connections: 4 });
        const url = `http://127.0.0.1:${port}/?status=500&size=${size}`;
        const call = () => undiciFetch(url, { dispatcher: agent });
        const started = Date.now();
        const outcome = await bounded(async () => {
          if (shape === "headersFirst") {
            const responses = await Promise.all(
              Array.from({ length: 20 }, () => call())
            );
            await Promise.all(responses.map((r) => CONSUMERS[consumer](r)));
          } else {
            await Promise.all(
              Array.from({ length: 20 }, () =>
                call().then((r) => CONSUMERS[consumer](r))
              )
            );
          }
          return "ok";
        });
        const measured = {
          outcome,
          sockets: opened(),
          elapsed: Date.now() - started,
        };
        agent.destroy().catch(() => undefined);
        return measured;
      });
      const cell =
        result.outcome === "ok"
          ? `${pad(result.sockets, 2)}s/${pad(result.elapsed, 4)}ms`
          : "STARVED";
      if (shape === "headersFirst") line.push(`${consumer}: hdr1st=${cell}`);
      else line[line.length - 1] += ` stream=${cell}`;
    }
  }
  console.log(`  ${sizeLabel.padEnd(7)}`);
  for (const entry of line) console.log(`      ${entry}`);
}

console.log(
  "\nD. npm undici, pool of 1: does ONE held body block the very next request?"
);
console.log("   The cleanest single-variable test of where the threshold sits.\n");
for (const [sizeLabel, size] of SIZES) {
  const cells = [];
  for (const consumer of ["unread", "drain", "cancel"]) {
    const result = await withServer(async ({ port, opened }) => {
      const agent = new Agent({ connections: 1 });
      const first = await undiciFetch(
        `http://127.0.0.1:${port}/?status=500&size=${size}`,
        { dispatcher: agent }
      );
      // Held on purpose. An unreferenced body would let GC decide the answer,
      // and GC timing is not a rule worth reporting as one.
      await CONSUMERS[consumer](first);
      const started = Date.now();
      const outcome = await bounded(async () => {
        const next = await undiciFetch(
          `http://127.0.0.1:${port}/?status=200&size=64`,
          { dispatcher: agent }
        );
        await next.text();
        return "ok";
      });
      const measured = { outcome, sockets: opened(), elapsed: Date.now() - started };
      await first.body?.cancel().catch(() => undefined);
      agent.destroy().catch(() => undefined);
      return measured;
    });
    cells.push(
      `${consumer}=${
        result.outcome === "ok" ? `ok ${pad(result.elapsed, 4)}ms` : "BLOCKED  "
      }`
    );
  }
  console.log(`  ${sizeLabel.padEnd(7)} ${cells.join("   ")}`);
}

console.log("\nDone.");
process.exit(0);
