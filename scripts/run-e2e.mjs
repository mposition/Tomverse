import { spawnSync } from "node:child_process";
import { join } from "node:path";
const env = {
  ...process.env,
  ALLOWED_REQUEST_HOSTS: [
    process.env.ALLOWED_REQUEST_HOSTS,
    "127.0.0.1:3100",
    "localhost:3100",
  ]
    .filter(Boolean)
    .join(","),
  DATABASE_URL: "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1",
  DIRECT_URL: "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1",
  E2E_AUTH_BYPASS: "true",
  E2E_DISABLE_DATABASE: "true",
  REQUIRE_CLOUDFLARE_ORIGIN_SECRET: "false",
};

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm CLI path is unavailable.");
const build = spawnSync(process.execPath, [npmCli, "run", "build"], {
  stdio: "inherit",
  env,
});
if (build.status !== 0) process.exit(build.status ?? 1);

const playwrightCli = join(process.cwd(), "node_modules", "playwright", "cli.js");
const test = spawnSync(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
process.exit(test.status ?? 1);
