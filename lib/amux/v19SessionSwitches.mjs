/**
 * The web-service switches the AMUX subscription analysis flow still reads, as
 * one list, so an environment is switched on by one operator command
 * (scripts/amux-v19-switches.mjs) instead of dashboard entries.
 * tests/amuxV19SessionSwitches.test.mjs keeps this list equal to the names the
 * code reads.
 *
 * Owner direction 2026-11-16: the per-route read and write switches of the
 * idea flow are gone; those routes are always open. What is left here guards
 * an irreversible boundary: the two automatic-deletion (retention) switches
 * that the analysis result route needs before it stores content, and the two
 * spending switches the owner approves a paid analysis with.
 *
 * Every value is the plain word `enabled`; none of these is a secret.
 */

/** The two automatic-deletion switches. The analysis result write route
 * refuses to open without them, so content is never stored without its
 * deleter running. */
export const AMUX_V19_SESSION_FLOW_SWITCHES = Object.freeze([
  "TOMVERSE_AMUX_V19_READ_MANIFEST_RETENTION",
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_RETENTION",
]);

/** Spending switches the flow stands on: the Admin screens where the owner
 * approves the price of an analysis and reserves its monthly budget. */
export const AMUX_V19_V4_PREREQUISITE_SWITCHES = Object.freeze([
  "TOMVERSE_AMUX_V4_ANALYSIS_PRICE_WRITE",
  "TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE",
]);

export const AMUX_V19_WEB_SWITCHES = Object.freeze([
  ...AMUX_V19_SESSION_FLOW_SWITCHES, ...AMUX_V19_V4_PREREQUISITE_SWITCHES]);

/** Read by the web service but set by a person, never by the switch script:
 * secrets, and the separate automatic-registration decision. */
export const AMUX_V19_WEB_OPERATOR_VALUES = Object.freeze([
  "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
  "TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET",
  "TOMVERSE_AMUX_V19_GITHUB_READ_TOKEN",
  "TOMVERSE_AMUX_V19_SYSTEM_REGISTRATION",
]);

/** Read on the Ubuntu runner or the operator's PC, never by the web service. */
export const AMUX_V19_NON_WEB_VALUES = Object.freeze([
  "TOMVERSE_AMUX_SESSION_INTAKE_ORIGIN",
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN",
  "TOMVERSE_AMUX_V19_MAX_SESSION_CYCLE",
  "TOMVERSE_AMUX_V19_DIAGNOSTIC_DETAIL",
  "TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI",
  "TOMVERSE_AMUX_V19_TRACKED_REPOSITORY_ROOT",
]);
