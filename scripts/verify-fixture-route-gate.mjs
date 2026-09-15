import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

/**
 * Proves, over real HTTP, that browser-only `/e2e` fixture routes are served
 * only on a Playwright fixture server and are 404 everywhere else.
 *
 * The route is gated on `isE2EFixtureMode()` (lib/e2eTestMode.ts), whose
 * behaviour matrix is unit-tested in `tests/e2eTestMode.test.mjs`. That proves
 * the helper; this proves the *deployment*: the same production build, started
 * twice, differing only in the environment the gate reads.
 *
 * `NODE_ENV` is not the difference between the two runs -- `next start` sets it
 * to production either way, which is exactly why the gate cannot rely on it.
 * The production-like run keeps a public `NEXTAUTH_URL`, so
 * `isLoopbackDeployment()` is false; `ALLOWED_REQUEST_HOSTS` is set so the
 * request still clears the host allowlist and the 404 is the route's own
 * answer rather than an origin rejection.
 *
 * Reuses the existing `.next` build. Run `npm run build` first.
 */

const ROUTES = [
  { path: "/e2e/admin-console-fixture", method: "GET" },
  { path: "/e2e/prompt-refiner-fixture", method: "GET" },
  {
    path: "/e2e/prompt-refiner-adapter",
    method: "POST",
    body: JSON.stringify({ requestId: "fixture_gate", prompt: "gate probe" }),
  },
];
const ROOT = resolve(import.meta.dirname, "..");

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });

const BASE_ENV = {
  ...process.env,
  DATABASE_URL: "postgresql://gate:gate@127.0.0.1:1/gate?connect_timeout=1",
  DIRECT_URL: "postgresql://gate:gate@127.0.0.1:1/gate?connect_timeout=1",
  NEXTAUTH_SECRET:
    process.env.NEXTAUTH_SECRET || "tomverse-fixture-route-gate-secret-2026",
  REQUIRE_CLOUDFLARE_ORIGIN_SECRET: "false",
  DISABLE_CSP_UPGRADE_INSECURE_REQUESTS: "true",
};

const startServer = async (label, buildEnvironment) => {
  const port = await freePort();
  const environment = buildEnvironment(port);
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)],
    {
      cwd: ROOT,
      env: {
        ...BASE_ENV,
        ...environment,
        ALLOWED_REQUEST_HOSTS: `127.0.0.1:${port},localhost:${port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const log = [];
  child.stdout.on("data", (chunk) => log.push(String(chunk)));
  child.stderr.on("data", (chunk) => log.push(String(chunk)));

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `${label} server exited with code ${child.exitCode}:\n${log.join("")}`
      );
    }
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/api/ready`, {
        signal: AbortSignal.timeout(2_000),
      });
      // Any answer means the listener is up; /api/ready's own verdict is not
      // what is under test here.
      if (probe.status > 0) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`${label} server did not start:\n${log.join("")}`);
    }
    await new Promise((wait) => setTimeout(wait, 500));
  }
  return { child, port, log };
};

const stopServer = async (server) => {
  if (!server) return;
  server.child.kill("SIGTERM");
  await new Promise((done) => {
    const timer = setTimeout(() => {
      server.child.kill("SIGKILL");
      done();
    }, 5_000);
    server.child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
  });
};

const statusOf = async (port, route) => {
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    ...(route.body
      ? {
          headers: { "Content-Type": "application/json" },
          body: route.body,
        }
      : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  return response.status;
};

const failures = [];
const check = (label, actual, expected) => {
  if (actual === expected) {
    console.log(`  ok   ${label}: HTTP ${actual}`);
    return;
  }
  console.error(`  FAIL ${label}: expected HTTP ${expected}, got ${actual}`);
  failures.push(label);
};

if (!existsSync(resolve(ROOT, ".next/BUILD_ID"))) {
  console.error(
    "No production build found. Run `npm run build` before this check."
  );
  process.exit(1);
}

console.log(
  `[fixture-route-gate] Probing ${ROUTES.map(({ method, path }) => `${method} ${path}`).join(", ")} against one shared build.`
);

let productionLike = null;
let fixture = null;
try {
  productionLike = await startServer("production-like", () => ({
    // A real deployment: public origin, no Playwright flags.
    NEXTAUTH_URL: "https://tomverse.app",
    E2E_AUTH_BYPASS: "",
    E2E_DISABLE_DATABASE: "",
  }));
  for (const route of ROUTES) {
    check(
      `production-like origin, no flags: ${route.method} ${route.path}`,
      await statusOf(productionLike.port, route),
      404
    );
  }

  // The flags alone must not open it: a stray or leaked variable on a real
  // deployment still has to fail closed.
  await stopServer(productionLike);
  productionLike = await startServer("production-like with flags", () => ({
    NEXTAUTH_URL: "https://tomverse.app",
    E2E_AUTH_BYPASS: "true",
    E2E_DISABLE_DATABASE: "true",
  }));
  for (const route of ROUTES) {
    check(
      `production-like origin, both flags set: ${route.method} ${route.path}`,
      await statusOf(productionLike.port, route),
      404
    );
  }
  await stopServer(productionLike);
  productionLike = null;

  // NEXTAUTH_URL has to name the port the server actually listens on, which is
  // only known once it has been allocated.
  fixture = await startServer("fixture", (port) => ({
    NEXTAUTH_URL: `http://127.0.0.1:${port}`,
    E2E_AUTH_BYPASS: "true",
    E2E_DISABLE_DATABASE: "true",
  }));
  for (const route of ROUTES) {
    check(
      `loopback origin, both flags set: ${route.method} ${route.path}`,
      await statusOf(fixture.port, route),
      200
    );
  }
} finally {
  await stopServer(productionLike);
  await stopServer(fixture);
}

if (failures.length > 0) {
  console.error(
    `\nFixture route gate check failed: ${failures.join(", ")}.`
  );
  process.exit(1);
}
console.log(
  `\nFixture route gate check passed (${ROUTES.length * 3} route probes).`
);
