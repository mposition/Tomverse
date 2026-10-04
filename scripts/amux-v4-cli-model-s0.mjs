/** Operator-invoked Ubuntu S0 only. No app claim, private document or idea
 * enters this process; one invocation of this script makes one CLI call. */
import { AMUX_V4_CODEX_S0_ENABLED, AMUX_V4_CLAUDE_S0_ENABLED,
  runAmuxV4IsolatedSyntheticCliS0 } from
  "../lib/amux/ideaLocalIsolatedCliRunner.mjs";

const provider = process.argv[2];
if (process.platform !== "linux" ||
    process.argv.length !== 3 ||
    !["openai", "anthropic"].includes(provider) ||
    !(provider === "openai" ? AMUX_V4_CODEX_S0_ENABLED : AMUX_V4_CLAUDE_S0_ENABLED) ||
    process.env.AMUX_V4_SYNTHETIC_S0_APPROVED !== "1") {
  process.stderr.write("AMUX_V4_CLI_MODEL_S0_REFUSED\n");
  process.exitCode = 2;
} else {
  const result = await runAmuxV4IsolatedSyntheticCliS0(provider);
  if (result.kind === "refused") {
    process.stderr.write("AMUX_V4_CLI_MODEL_S0_REFUSED\n");
    process.exitCode = 2;
  } else {
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
      unexpectedEventType: result.kind === "outcome_unknown" ?
        result.unexpectedEventType ?? null : null,
      unexpectedEventPhase: result.kind === "outcome_unknown" ?
        result.unexpectedEventPhase ?? null : null,
      unexpectedSystemSubtype: result.kind === "outcome_unknown" ?
        result.unexpectedSystemSubtype ?? null : null,
      unexpectedSystemSubtypeDigest: result.kind === "outcome_unknown" ?
        result.unexpectedSystemSubtypeDigest ?? null : null,
      unexpectedSystemHasCapabilities: result.kind === "outcome_unknown" ?
        result.unexpectedSystemHasCapabilities ?? null : null,
      unexpectedSystemHasFreeText: result.kind === "outcome_unknown" ?
        result.unexpectedSystemHasFreeText ?? null : null,
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
