const FAILURE_STAGES = new Set([
  "deadline", "stdout_limit", "child_nonzero", "child_io_error",
  "setup_or_spawn_error", "parser_rejected",
]);
const PARSER_REASONS = new Set([
  "incomplete_output", "output_contract_mismatch",
  "security_no_tools_violation", "usage_unverified", "served_model_mismatch",
]);
const REJECTION_POINTS = new Set([
  "ui_invalidate_shape", "rate_limit_shape", "init_shape", "assistant_shape",
  "assistant_stop", "result_order", "unexpected_event", "turn_count",
  "model_count", "result_shape",
]);

/** Copy only fixed codes, never CLI text, usage, event names or credentials. */
export function amuxV4AnalysisCliDiagnostic(cliResult) {
  if (cliResult?.kind !== "outcome_unknown" ||
      !FAILURE_STAGES.has(cliResult.failureStage)) return null;
  const failureStage = cliResult.failureStage;
  const parserReason = failureStage === "parser_rejected" &&
    PARSER_REASONS.has(cliResult.parserReason) ? cliResult.parserReason : null;
  const rejectionPoint = parserReason === "output_contract_mismatch" &&
    REJECTION_POINTS.has(cliResult.rejectionPoint) ? cliResult.rejectionPoint : null;
  return { failureStage, parserReason, rejectionPoint };
}

/** Diagnostics are local only and cannot change the app outcome or halt. */
export function amuxV4AnalysisWithCliDiagnostic(result, cliResult) {
  if (!["outcome_unknown", "result_unknown"].includes(result?.kind)) return result;
  const diagnostic = amuxV4AnalysisCliDiagnostic(cliResult);
  return diagnostic ? { ...result, diagnostic } : result;
}

/** Re-project at the logging boundary, even if the caller supplies extra data. */
export function amuxV4AnalysisDiagnosticLog(result) {
  if (!["outcome_unknown", "result_unknown"].includes(result?.kind)) return "";
  const diagnostic = amuxV4AnalysisCliDiagnostic({
    ...result.diagnostic, kind: "outcome_unknown",
  });
  return diagnostic
    ? `AMUX_V4_LOCAL_ANALYSIS_DIAGNOSTIC ${JSON.stringify(diagnostic)}\n` : "";
}
