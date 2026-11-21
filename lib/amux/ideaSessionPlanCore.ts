/**
 * Session-written plans (owner decision 2026-11-21, docs/policy/amux-intake.md
 * "세션 계획 첨부 접수"). A coding session may attach the plan it wrote to its
 * intake. The plan passes the box answer's parser and the intake content checks
 * and then waits for the owner's one plan approval, exactly like a box plan.
 *
 * The idea intake is the door through which code is changed under the
 * operator's GitHub account, so a session plan is registered without that
 * approval only behind this separate default-off switch, on only for the exact
 * word `enabled`. It is not the box analysis switch
 * (TOMVERSE_AMUX_V19_SYSTEM_REGISTRATION): turning box plans on never turns
 * session plans on.
 */
export const AMUX_SESSION_PLAN_AUTO_REGISTER_ENV =
  "TOMVERSE_AMUX_SESSION_PLAN_AUTO_REGISTER";

export function amuxSessionPlanAutoRegisterEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[AMUX_SESSION_PLAN_AUTO_REGISTER_ENV] === "enabled";
}

/** Stored as the page's model on its transfer preview: no model of the
 * operating scope analysed this page, a coding session wrote it. */
export const AMUX_SESSION_PLAN_MODEL_ID = "session-written-plan";

/** Where a session plan stands after its intake committed. */
export type AmuxSessionPlanRegistration =
  | { state: "awaiting_approval" }
  | { state: "registered" }
  /** The automatic registration did not report a commit. The code is the
   * registration Guard's closed word; on outcome_unknown the Admin idea shows
   * whether the cards exist. Nothing retries it. */
  | { state: "registration_incomplete"; code: string };

const STATES = new Set(["awaiting_approval", "registered", "registration_incomplete"]);
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** The closed shape a client accepts back for an attached plan. */
export function readAmuxSessionPlanRegistration(value: unknown):
  (AmuxSessionPlanRegistration & { unitCount: number }) | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.state !== "string" || !STATES.has(record.state) ||
      !Number.isSafeInteger(record.unitCount) || (record.unitCount as number) < 1) {
    return null;
  }
  const unitCount = record.unitCount as number;
  if (record.state === "registration_incomplete") {
    return typeof record.code === "string" && CODE.test(record.code)
      ? { state: "registration_incomplete", code: record.code, unitCount } : null;
  }
  return { state: record.state as "awaiting_approval" | "registered", unitCount };
}
