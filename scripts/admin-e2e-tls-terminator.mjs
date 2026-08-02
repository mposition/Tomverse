import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";

/**
 * TLS in front of the Admin Console E2E server.
 *
 * `next start` speaks http only, and this suite needs https for one concrete
 * reason: it signs in by injecting a minted NextAuth JWT, and since SEC-010 a
 * production server reads that token from `__Secure-next-auth.session-token`.
 * Chromium's CDP `Storage.setCookies` refuses to write a `__Secure-` cookie
 * whose source URL is not https, and Playwright's `APIRequestContext` will not
 * attach a `Secure` cookie to an http request -- so on plain http the suite can
 * neither create the session nor send it to `/api/admin/**`. Serving https is
 * what lets the harness meet the production cookie contract instead of asking
 * the server to weaken it.
 *
 * It terminates at the byte level -- accept a TLS socket, pipe it to the
 * loopback http port -- rather than re-issuing requests. There is no header
 * rewriting, no body buffering and no chunked-encoding handling to get subtly
 * wrong, and the browser's own `Host` header survives untouched, which is what
 * `ALLOWED_REQUEST_HOSTS` and `lib/requestOrigin.ts` match on.
 *
 * The certificate is generated per run into a temporary directory and deleted
 * on exit. Nothing about it is secret: it is a throwaway key for a loopback
 * listener holding synthetic data, and Playwright is the only client. It is
 * never written into the repository, so there is no key to leak and none for
 * the secret scanners to find.
 */

const HARNESS_CONFIG = "../tests/e2e-admin/support/harness-config.ts";

const loadHarnessConfig = async () => {
  try {
    return await import(HARNESS_CONFIG);
  } catch (error) {
    // Only a "node cannot load TypeScript here" failure is retried; anything
    // else is a real problem and must not be hidden by the fallback.
    if (
      error?.code !== "ERR_UNKNOWN_FILE_EXTENSION" &&
      error?.code !== "ERR_MODULE_NOT_FOUND" &&
      !(error instanceof SyntaxError)
    ) {
      throw error;
    }
    const { register } = await import("tsx/esm/api");
    register();
    return import(HARNESS_CONFIG);
  }
};

const { ADMIN_E2E_APP_PORT, ADMIN_E2E_HOST, ADMIN_E2E_PORT } =
  await loadHarnessConfig();

const fail = (message) => {
  console.error(`[admin-e2e-tls] ${message}`);
  process.exit(1);
};

// Fail closed rather than ever exposing a throwaway certificate on a routable
// interface. The harness has no reason to bind anything else.
if (ADMIN_E2E_HOST !== "127.0.0.1" && ADMIN_E2E_HOST !== "::1") {
  fail(`refusing to serve the test certificate on ${ADMIN_E2E_HOST}: loopback only.`);
}

const certificateDirectory = mkdtempSync(join(tmpdir(), "tomverse-admin-e2e-tls-"));
const keyPath = join(certificateDirectory, "key.pem");
const certificatePath = join(certificateDirectory, "cert.pem");

try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      // A day is more than one CI run and less than anything worth reusing.
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
} catch (error) {
  const detail = error?.stderr?.toString().trim() || error?.message || "";
  fail(
    [
      "could not generate the throwaway TLS certificate with `openssl`.",
      "The Admin Console E2E harness serves https so the production",
      "`__Secure-` session cookie can be injected at all; see",
      "tests/e2e-admin/support/harness-config.ts.",
      "Install openssl (it ships with the GitHub Actions runners, macOS and",
      "most Linux distributions) and re-run.",
      detail && `openssl said: ${detail}`,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

const server = createServer(
  {
    key: readFileSync(keyPath),
    cert: readFileSync(certificatePath),
    // Chromium would otherwise negotiate h2, which `next start` does not speak
    // and this terminator does not translate.
    ALPNProtocols: ["http/1.1"],
  },
  (socket) => {
    const upstream = connect(ADMIN_E2E_APP_PORT, ADMIN_E2E_HOST);
    // A half-open socket on either side is normal during shutdown; destroying
    // the pair keeps a dead connection from holding the process open.
    const drop = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on("error", drop);
    upstream.on("error", drop);
    socket.pipe(upstream).pipe(socket);
  }
);

const cleanUp = () => {
  rmSync(certificateDirectory, { recursive: true, force: true });
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    cleanUp();
    process.exit(0);
  });
}
process.on("exit", cleanUp);

server.on("error", (error) => fail(`could not listen on ${ADMIN_E2E_PORT}: ${error.message}`));
server.listen(ADMIN_E2E_PORT, ADMIN_E2E_HOST, () => {
  console.log(
    `[admin-e2e-tls] https://${ADMIN_E2E_HOST}:${ADMIN_E2E_PORT} -> http://${ADMIN_E2E_HOST}:${ADMIN_E2E_APP_PORT}`
  );
});
