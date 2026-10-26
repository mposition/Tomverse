import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { guardedMcpFetch } from "../lib/mcpConnectorClient";

const SETUP_ORIGIN = "http://127.0.0.1:3132";
const CALLBACK = "http://127.0.0.1:3131/api/mcp/oauth/callback";
const REPOSITORY = "mposition/TomverseCode", REPOSITORY_ID = 1309523852;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
type AppConfig = { clientId: string; clientSecret: string; slug: string; repository: string; repositoryId: number; encryptionKey: string; sessionSecret: string };

export function githubPreviewManifest(suffix: string) {
  return { name: `Tomverse MCP Local ${suffix}`, url: "https://tomverse.app", public: false,
    description: "Local Tomverse MCP preview. Issue access is limited to the repository selected during installation.",
    redirect_url: `${SETUP_ORIGIN}/callback`, callback_urls: [CALLBACK],
    hook_attributes: { url: "https://tomverse.app", active: false }, request_oauth_on_install: false,
    default_permissions: { issues: "write", metadata: "read" }, default_events: [] };
}

export function githubPreviewAppConfig(raw: unknown): AppConfig {
  const app = raw as { client_id?: unknown; client_secret?: unknown; slug?: unknown; owner?: { login?: unknown }; permissions?: Record<string, unknown>; public?: unknown };
  if (!app || app.owner?.login !== "mposition" || app.public === true || typeof app.client_id !== "string" || !/^[A-Za-z0-9_.-]{1,512}$/.test(app.client_id) ||
    typeof app.client_secret !== "string" || !/^[A-Za-z0-9_-]{16,512}$/.test(app.client_secret) || typeof app.slug !== "string" || !/^[a-z0-9-]{1,100}$/.test(app.slug) ||
    !app.permissions || app.permissions.issues !== "write" || app.permissions.metadata !== "read" || Object.keys(app.permissions).some(key => !["issues", "metadata"].includes(key)))
    throw new Error("Unexpected GitHub App registration; no credential was saved.");
  // Discard the generated private key and webhook secret: this flow only uses OAuth.
  return { clientId: app.client_id, clientSecret: app.client_secret, slug: app.slug, repository: REPOSITORY, repositoryId: REPOSITORY_ID,
    encryptionKey: randomBytes(48).toString("base64url"), sessionSecret: randomBytes(48).toString("base64url") };
}

export function createGithubPreviewSetup(deps: { exchange: (code: string) => Promise<unknown>; persist: (config: AppConfig) => Promise<void>; now?: () => number }) {
  const now = deps.now || Date.now, expiresAt = now() + 15 * 60_000;
  const bootstrap = randomBytes(32).toString("base64url"), cookie = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url");
  let bootstrapped = false, phase: "pending" | "running" | "complete" | "unknown" = "pending", slug = "";
  const manifest = githubPreviewManifest(randomBytes(4).toString("hex"));
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'");
    if (req.headers.host !== "127.0.0.1:3132" || req.method !== "GET" || now() >= expiresAt) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url || "/", SETUP_ORIGIN);
    if (!bootstrapped && url.pathname === `/open/${bootstrap}`) {
      bootstrapped = true; res.setHeader("Set-Cookie", `mcp-setup=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=900`);
      res.writeHead(303, { Location: "/" }); res.end(); return;
    }
    if (!req.headers.cookie?.split(/;\s*/).includes(`mcp-setup=${cookie}`)) { res.writeHead(403); res.end(); return; }
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (phase !== "pending" || url.searchParams.get("state") !== state || !code || !/^[A-Za-z0-9_-]{1,512}$/.test(code)) { res.writeHead(403); res.end(); return; }
      phase = "running";
      try { const config = githubPreviewAppConfig(await deps.exchange(code)); await deps.persist(config); slug = config.slug; phase = "complete"; }
      catch { phase = "unknown"; }
      res.writeHead(303, { Location: phase === "complete" ? `https://github.com/apps/${slug}/installations/new` : "/" }); res.end(); return;
    }
    if (url.pathname !== "/") { res.writeHead(404); res.end(); return; }
    let body = `<h1>GitHub OAuth setup</h1><p>Sign in to GitHub as <strong>mposition</strong> before creating this private app. Repository: <strong>${REPOSITORY}</strong>. Another account's registration cannot be used here.</p><p>Requested access: Issues read/write and repository metadata read. Webhooks are disabled. No issues are read or created during registration.</p>`;
    if (phase === "pending") body += `<form action="https://github.com/settings/apps/new?state=${state}" method="post"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button>Create GitHub App</button></form>`;
    else if (phase === "complete") body += `<p>App credentials are encrypted for your Windows account outside the repository.</p><p><a href="https://github.com/apps/${slug}/installations/new" rel="noreferrer">Install on TomverseCode only</a></p><p>Then start the local preview and choose Plugins → GitHub → Connect. Registration does not enable Dev or Production.</p>`;
    else body += `<p>Registration ${phase === "unknown" ? "could not be confirmed. Check GitHub App settings before restarting; the exchange will not be retried." : "is in progress."}</p>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Tomverse GitHub OAuth</title><style>body{font:16px system-ui;max-width:660px;margin:8vh auto;padding:24px;background:#f5f7fb;color:#172033;line-height:1.6}button,a{font:inherit}button{background:#172033;color:white;border:0;padding:12px 20px;border-radius:10px;cursor:pointer}h1{line-height:1.2}</style>${body}</html>`);
  });
  return { server, bootstrapUrl: `${SETUP_ORIGIN}/open/${bootstrap}` };
}

function dpapi(mode: "protect" | "unprotect", input: string) {
  const operation = mode === "protect" ? "Protect" : "Unprotect";
  const prepare = mode === "protect" ? "[Text.Encoding]::UTF8.GetBytes($mcpInput)" : "[Convert]::FromBase64String($mcpInput)";
  const finish = mode === "protect" ? "[Convert]::ToBase64String($mcpResult)" : "[Text.Encoding]::UTF8.GetString($mcpResult)";
  const code = `Add-Type -AssemblyName System.Security; $mcpInput=[Console]::In.ReadToEnd(); $mcpResult=[Security.Cryptography.ProtectedData]::${operation}(${prepare},$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write(${finish})`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code], { input, encoding: "utf8", windowsHide: true, maxBuffer: 65_536 });
  if (result.status !== 0) throw new Error("Windows credential storage unavailable.");
  return result.stdout.trim();
}

async function main() {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) throw new Error("This local setup helper requires Windows user credential storage.");
  if (process.argv.includes("--self-test")) {
    const synthetic = "synthetic-local-credential-storage-test";
    if (dpapi("unprotect", dpapi("protect", synthetic)) !== synthetic) throw new Error("Credential storage self-test failed.");
    console.log("Windows credential storage self-test passed using synthetic data."); return;
  }
  const folder = join(process.env.LOCALAPPDATA, "Tomverse", "McpPreview");
  const path = join(folder, `github-${createHash("sha256").update(REPOSITORY).digest("hex").slice(0, 16)}.dpapi`);
  if (process.argv.includes("--dev")) {
    const db = new URL(process.env.DATABASE_URL || "");
    if (db.protocol !== "postgresql:" || db.hostname !== "127.0.0.1" || db.port !== "56439" || db.searchParams.get("schema") !== "mcp_oauth_preview")
      throw new Error("Use only the disposable local database on 127.0.0.1:56439 with schema=mcp_oauth_preview.");
    const config = JSON.parse(dpapi("unprotect", await readFile(path, "utf8"))) as AppConfig;
    if (config.repository !== REPOSITORY || config.repositoryId !== REPOSITORY_ID) throw new Error("Stored app does not match the preview repository.");
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", DATABASE_URL: db.href, DIRECT_DATABASE_URL: db.href,
      // Next 16's private dev performance trace ignores incomingRequests.ignore
      // and records callback query strings. Disable it only in this local child.
      NEXT_TRACE_SPAN_THRESHOLD_MS: String(Number.MAX_SAFE_INTEGER),
      PUBLIC_APP_URL: "http://127.0.0.1:3131", NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3131", NEXT_PUBLIC_SHARE_BASE_URL: "http://127.0.0.1:3131",
      NEXTAUTH_URL: "http://127.0.0.1:3131", NEXTAUTH_SECRET: config.sessionSecret,
      OAUTH_TOKEN_ENCRYPTION_KEY: config.encryptionKey, MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CONNECTOR_SERVERS: "[]",
      MCP_GITHUB_OAUTH_CLIENT_ID: config.clientId, MCP_GITHUB_OAUTH_CLIENT_SECRET: config.clientSecret,
      MCP_GITHUB_REPOSITORY: REPOSITORY, MCP_GITHUB_REPOSITORY_ID: String(REPOSITORY_ID),
      MCP_CONNECTOR_SYNTHETIC_PORT: "", MCP_CONNECTOR_NATIVE_ENABLED: "false", E2E_AUTH_BYPASS: "false", E2E_DISABLE_DATABASE: "false" };
    const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "-H", "127.0.0.1", "-p", "3131"], { env, stdio: "inherit", windowsHide: true });
    child.on("exit", code => { process.exitCode = code ?? 1; });
    return;
  }
  try { await readFile(path); throw new Error("A registered app already exists. Use dev:mcp-github; do not create another app."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const setup = createGithubPreviewSetup({
    exchange: async code => {
      const url = `https://api.github.com/app-manifests/${code}/conversions`;
      const response = await guardedMcpFetch({ id: "github-setup", name: "GitHub App registration", url, auth: "none", readTools: [] }, null, AbortSignal.timeout(8_000), true)
        (url, { method: "POST", headers: { Accept: "application/vnd.github+json" } });
      if (!response.ok) throw new Error("Registration exchange failed.");
      return response.json();
    },
    persist: async config => { await mkdir(folder, { recursive: true }); await writeFile(path, dpapi("protect", JSON.stringify(config)), { flag: "wx", mode: 0o600 }); },
  });
  await new Promise<void>((resolve, reject) => { setup.server.once("error", reject); setup.server.listen(3132, "127.0.0.1", resolve); });
  // Keep the helper hidden; the browser is the interactive owner-consent surface.
  const opener = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${setup.bootstrapUrl}'`], { windowsHide: true, stdio: "ignore" });
  opener.on("error", () => { setup.server.close(); process.exitCode = 1; });
  console.log("GitHub App registration opened in your browser. The setup expires in 15 minutes; no credentials are printed.");
  setTimeout(() => setup.server.close(), 15 * 60_000).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(() => {
  console.error("GitHub setup could not complete. Check the local database/configuration or GitHub App settings. No credentials were printed."); process.exitCode = 1;
});
