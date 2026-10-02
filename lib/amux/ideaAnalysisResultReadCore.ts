export const AMUX_V4_ANALYSIS_RESULT_READ_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_RESULT_READ";
export const AMUX_V4_ANALYSIS_RESULT_READ_CODE_ENABLED = false;

export const amuxV4AnalysisResultReadEnabled = (value: string | undefined): boolean =>
  AMUX_V4_ANALYSIS_RESULT_READ_CODE_ENABLED && value === "enabled";
