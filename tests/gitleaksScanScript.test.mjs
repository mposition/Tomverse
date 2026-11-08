/**
 * scripts/ci/gitleaks-scan.sh replaced gitleaks/gitleaks-action@v3 on
 * 2026-11-08, after the release web download path the action depends on
 * returned 504 and PR Fast Gate could not install gitleaks. These checks keep
 * the replacement honest: the REST asset path comes first, the archive is
 * verified against both a pinned sha256 and the release checksums file, the
 * scan keeps the action's flags and exit mapping, and all three workflows run
 * the script rather than the action.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GITLEAKS_PIN } from "../scripts/check-gitleaks-exact-range.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const script = read("scripts/ci/gitleaks-scan.sh");

const WORKFLOWS = [
  ".github/workflows/pr-fast-gate.yml",
  ".github/workflows/secret-history-scan.yml",
  ".github/workflows/daily-security-audit.yml",
];

test("the script pins the same gitleaks version as the exact-range guard", () => {
  assert.match(script, new RegExp(`^readonly GITLEAKS_VERSION="${GITLEAKS_PIN.version.replaceAll(".", "\\.")}"$`, "mu"));
  assert.match(script, /^readonly ARCHIVE_SHA256="[0-9a-f]{64}"$/mu);
  assert.match(script, /^readonly ARCHIVE_ASSET_ID="\d+"$/mu);
  assert.match(script, /^readonly CHECKSUMS_ASSET_ID="\d+"$/mu);
});

test("the download tries the release asset API before the release web path", () => {
  const api = script.indexOf("https://api.github.com/repos/${GITLEAKS_REPO}/releases/assets/${asset_id}");
  const web = script.indexOf("https://github.com/${GITLEAKS_REPO}/releases/download/");
  assert.ok(api > 0, "uses the REST asset endpoint");
  assert.ok(web > api, "the web path is only the fallback");
  assert.match(script, /-H "Accept: application\/octet-stream"/u);
});

test("the archive must match the pin and the published checksums before it runs", () => {
  const installer = script.slice(script.indexOf("install_gitleaks() {"), script.indexOf("# Sets LOG_OPTS"));
  assert.match(installer, /fetch "\$CHECKSUMS_ASSET_ID" "\$CHECKSUMS_NAME"/u);
  assert.match(installer, /if \[ "\$published" != "\$ARCHIVE_SHA256" \]; then[\s\S]*?exit 1/u);
  assert.match(installer, /if \[ "\$actual" != "\$ARCHIVE_SHA256" \]; then[\s\S]*?exit 1/u);
  assert.ok(
    installer.indexOf('"$actual" != "$ARCHIVE_SHA256"') < installer.indexOf("tar -xzf"),
    "the hash is checked before the archive is extracted"
  );
  assert.match(installer, /if \[ "\$version" != "\$GITLEAKS_VERSION" \]; then[\s\S]*?exit 1/u);
});

test("the scan keeps the action's flags, ranges and exit mapping", () => {
  for (const flag of ["detect", "--redact", "-v", "--report-format=sarif", "--report-path=results.sarif"]) {
    assert.ok(script.includes(`  ${flag}\n`), `passes ${flag}`);
  }
  assert.match(script, /^readonly EXIT_CODE_LEAKS_DETECTED=2$/mu);
  assert.ok(script.includes('"--exit-code=${EXIT_CODE_LEAKS_DETECTED}"'));
  assert.ok(script.includes('LOG_OPTS="--no-merges --first-parent ${merge_base}..${head}"'));
  assert.ok(script.includes('LOG_OPTS="--no-merges --first-parent ${first}^..${last}"'));
  assert.match(script, /schedule \| workflow_dispatch\)\n\s+;;/u, "scheduled and manual runs scan the whole history");
  assert.match(script, /\*\)\n\s+echo "::error::The \[\$\{GITHUB_EVENT_NAME:-\}\] event is not supported[^\n]*\n\s+exit 1/u);
  // Leaks fail the step; a gitleaks error keeps its own code.
  assert.match(script, /elif \[ "\$exit_code" -eq "\$EXIT_CODE_LEAKS_DETECTED" \]; then\n[^\n]*\n\s+exit 1\n/u);
  assert.match(script, /exit "\$exit_code"\nfi\n$/u);
  // gitleaks finds .gitleaks.toml and .gitleaksignore itself; overriding
  // either would change what the scan reports.
  assert.doesNotMatch(script, /--config|--gitleaks-ignore-path|--source/u);
});

test("every secret-scanning workflow runs the script, not gitleaks-action", () => {
  for (const path of WORKFLOWS) {
    const workflow = read(path);
    assert.doesNotMatch(workflow, /uses:\s*["']?gitleaks\/gitleaks-action@/u, path);
    assert.match(workflow, /run: scripts\/ci\/gitleaks-scan\.sh\n\s+env:\n\s+GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/u, path);
  }
  assert.match(
    read(".github/workflows/daily-security-audit.yml"),
    /id: gitleaks\n\s+continue-on-error: true\n\s+run: scripts\/ci\/gitleaks-scan\.sh/u,
    "the daily audit still reads steps.gitleaks.outcome"
  );
});

test("the script is committed executable", () => {
  const entry = execFileSync("git", ["ls-files", "-s", "scripts/ci/gitleaks-scan.sh"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.match(entry, /^100755 /u, "a `run:` of the path needs the executable bit");
});
