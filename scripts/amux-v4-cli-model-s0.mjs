/** Operator-invoked Ubuntu S0 only. No app claim, private document or idea
 * enters this process; one invocation of this script makes one CLI call. */
import { AMUX_V4_CODEX_S0_ENABLED, AMUX_V4_CLAUDE_S0_ENABLED,
  runAmuxV4IsolatedSyntheticCliS0 } from
  "../lib/amux/ideaLocalIsolatedCliRunner.mjs";
import { claimAmuxV4SyntheticS0Once } from "../lib/amux/ideaLocalS0Once.mjs";

const provider = process.argv[2];
const APPROVAL_EXPIRES_AT = Date.parse("2026-10-05T00:00:00.000Z");
const CLAIM_DIRECTORY = "/home/tommy/.amux-cli-profiles";
const MARKER = Object.freeze({
  anthropic: "s0-claude-20261004-diagnostic-3.claimed",
  openai: "s0-codex-20261004-original.claimed",
});
if (process.platform !== "linux" ||
    process.argv.length !== 3 ||
    !["openai", "anthropic"].includes(provider) ||
    !(provider === "openai" ? AMUX_V4_CODEX_S0_ENABLED : AMUX_V4_CLAUDE_S0_ENABLED) ||
    process.env.AMUX_V4_SYNTHETIC_S0_APPROVED !== "1") {
  process.stderr.write("AMUX_V4_CLI_MODEL_S0_REFUSED\n");
  process.exitCode = 2;
} else {
  const claimed = await claimAmuxV4SyntheticS0Once({
    directory: CLAIM_DIRECTORY, markerName: MARKER[provider],
    expiresAt: APPROVAL_EXPIRES_AT,
  });
  if (!claimed) {
    process.stderr.write("AMUX_V4_CLI_MODEL_S0_REFUSED\n");
    process.exitCode = 2;
  } else {
    const result = await runAmuxV4IsolatedSyntheticCliS0(provider);
    const transport = result.kind === "verified_success" ||
      result.kind === "model_unverified";
    const outputMatches = result.kind === "verified_success" &&
      result.rawModelOutput.trim() === "S0_OK" ||
      result.kind === "model_unverified" && result.answerMatchesS0 === true;
    process.stdout.write(JSON.stringify({ provider,
      status: result.kind, transport,
      failureStage: result.kind === "outcome_unknown" ? result.failureStage ?? null : null,
      parserReason: result.kind === "outcome_unknown" ? result.parserReason ?? null : null,
      rejectionPoint: result.kind === "outcome_unknown" ?
        result.rejectionPoint ?? null : null,
      childExitCode: result.kind === "outcome_unknown" ? result.childExitCode ?? null : null,
      approvedConnects: result.kind === "outcome_unknown" ?
        result.approvedConnects ?? null : null,
      deniedConnects: result.kind === "outcome_unknown" ?
        result.deniedConnects ?? null : null,
      answerMatchesS0: transport ? outputMatches : null,
      servedModelVerified: result.kind === "verified_success",
      inputTokens: transport ? result.inputTokens : null,
      outputTokens: transport ? result.outputTokens : null }) + "\n");
    if (!transport || !outputMatches) {
      process.exitCode = 1;
    }
  }
}
