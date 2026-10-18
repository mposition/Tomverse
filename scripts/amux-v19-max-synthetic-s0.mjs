/** One operator-approved Max subscription probe on the Ubuntu runner.
 * This synthetic path has no app claim or user content and cannot retry. */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claimAmuxV4SyntheticS0Once } from
  "../lib/amux/ideaLocalS0Once.mjs";
import { verifyAmuxV19ClaudeMaxAuthSource,
  AMUX_V19_CLAUDE_MAX_AUTH_PATH } from
  "../lib/amux/ideaV19ClaudeMaxAuth.mjs";
import { runAmuxV19TrackedCheckoutAnalysis,
  AMUX_V19_TRACKED_CHECKOUT_CLI_ENV,
  AmuxTrackedCheckoutHostError } from
  "../lib/amux/ideaTrackedCheckoutHostRunner.mjs";

const run = promisify(execFile);
const CLI = "/home/tommy/.local/share/claude/versions/2.1.288";
const CLI_SHA256 = "0298068b686e7fdbaf9402a7a587bb7f49c0b0e084de09f69145a0719207640c";
const CLAIM_DIR = "/home/tommy/.amux-cli-profiles";
// The first two separately approved calls consumed their markers and ended
// outcome_unknown. This third diagnostic attempt stays closed until approved.
const CLAIM_MARKER = "v19-max-synthetic-20261018-03.claimed";
const APPROVAL_EXPIRES_AT = Date.parse("2026-10-20T00:00:00.000Z");
const MAX_PROBE_MS = 120_000;
const SAFE_PREFLIGHT_REASONS = new Set([
  "synthetic_s0_refused", "synthetic_s0_cli_unavailable",
  "synthetic_s0_once_unavailable",
]);
let modelAttemptArmed = false;
const gitEnvironment = { PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (args) => run("/usr/bin/git", args,
  { env: gitEnvironment, timeout: 10_000 });

async function pinnedCliPresent() {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(CLI)) hash.update(bytes);
  return hash.digest("hex") === CLI_SHA256;
}

async function main() {
  if (process.platform !== "linux" || process.getuid?.() === 0 ||
      hostname() !== "tomverseagent" ||
      process.env.AMUX_V19_MAX_SYNTHETIC_S0_APPROVED !== "3" ||
      process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] !== undefined ||
      process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error("synthetic_s0_refused");
  }
  await verifyAmuxV19ClaudeMaxAuthSource(AMUX_V19_CLAUDE_MAX_AUTH_PATH);
  if (!await pinnedCliPresent()) throw new Error("synthetic_s0_cli_unavailable");
  const fixture = await mkdtemp("/tmp/amux-v19-s0-repo-");
  const prompt = Buffer.from(
    "Read TRACE.txt, then reply with exactly S0_OK and nothing else.", "utf8");
  try {
    await writeFile(join(fixture, "TRACE.txt"), "S0_OK\n", { flag: "wx", mode: 0o400 });
    await git(["init", "-q", "--template=", fixture]);
    await git(["-C", fixture, "add", "TRACE.txt"]);
    await git(["-C", fixture, "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgsign=false", "-c", "user.name=AMUX S0",
      "-c", "user.email=amux-s0@example.invalid", "commit", "-qm", "S0 fixture"]);
    const { stdout } = await git(["-C", fixture, "rev-parse", "HEAD"]);
    const commitSha = stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(commitSha) ||
        !await claimAmuxV4SyntheticS0Once({ directory: CLAIM_DIR,
          markerName: CLAIM_MARKER, expiresAt: APPROVAL_EXPIRES_AT })) {
      throw new Error("synthetic_s0_once_unavailable");
    }
    // Process-local admission only. No persistent operational switch changes.
    process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] = "enabled";
    modelAttemptArmed = true;
    const start = Date.now();
    const observed = await runAmuxV19TrackedCheckoutAnalysis({
      repositoryPath: fixture, commitSha,
      digestSecret: randomBytes(32).toString("hex"), prompt,
      modelId: "claude-opus-5-5", reasoningEffort: "high",
      diagnostic: true,
      stopCheck: async () => Date.now() - start >= MAX_PROBE_MS,
    });
    const passed = observed.kind === "verified_success" &&
      observed.rawModelOutput.trim() === "S0_OK" &&
      observed.readFiles.length === 1 && observed.readFiles[0] === "TRACE.txt";
    process.stdout.write(JSON.stringify({ status: observed.kind,
      cliStarted: observed.cliStarted === true,
      failureStage: observed.kind === "outcome_unknown"
        ? observed.failureStage ?? "unavailable" : null,
      childExitCode: observed.kind === "outcome_unknown"
        ? observed.childExitCode ?? null : null,
      approvedConnects: observed.kind === "outcome_unknown"
        ? observed.approvedConnects ?? null : null,
      deniedConnects: observed.kind === "outcome_unknown"
        ? observed.deniedConnects ?? null : null,
      answerMatches: observed.kind === "verified_success"
        ? observed.rawModelOutput.trim() === "S0_OK" : null,
      traceRead: observed.kind === "verified_success"
        ? observed.readFiles.length === 1 &&
          observed.readFiles[0] === "TRACE.txt" : null,
      inputTokens: observed.kind === "verified_success"
        ? observed.inputTokens : null,
      outputTokens: observed.kind === "verified_success"
        ? observed.outputTokens : null,
    }) + "\n");
    if (!passed) process.exitCode = 1;
  } finally {
    prompt.fill(0);
    delete process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
    await rm(fixture, { recursive: true, force: true });
  }
}

try { await main(); }
catch (error) {
  if (error instanceof AmuxTrackedCheckoutHostError) {
    process.stdout.write(JSON.stringify({ status: "outcome_unknown",
      cliStarted: error.cliStarted === true }) + "\n");
  } else if (modelAttemptArmed) {
    process.stdout.write(JSON.stringify({ status: "outcome_unknown",
      cliStarted: null }) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ status: "refused",
      reason: SAFE_PREFLIGHT_REASONS.has(error?.message)
        ? error.message : "preflight_unavailable", cliStarted: false }) + "\n");
  }
  process.stderr.write("AMUX_V19_MAX_SYNTHETIC_S0_FAIL\n");
  process.exitCode = 1;
}
