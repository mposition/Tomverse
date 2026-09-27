export const AMUX_INCIDENT_SETTING_KEY = "amux.incidentMode";
export const AMUX_INCIDENT_SETTING_VERSION = 1;

export const AMUX_INCIDENT_STATES = ["normal", "frozen"] as const;
export type AmuxIncidentStateName = (typeof AMUX_INCIDENT_STATES)[number];

export type AmuxIncidentState = {
  version: typeof AMUX_INCIDENT_SETTING_VERSION;
  state: AmuxIncidentStateName;
  transition_id: string | null;
  changed_at: string;
  reason: string;
  ticket: string;
};

export type AmuxIncidentReading = {
  state: AmuxIncidentState;
  valid: boolean;
  blocks_admission: boolean;
  problem: "missing" | "invalid_json" | "invalid_shape" | null;
};

const failClosedState = (now: Date): AmuxIncidentState => ({
  version: AMUX_INCIDENT_SETTING_VERSION,
  state: "frozen",
  transition_id: null,
  changed_at: now.toISOString(),
  reason:
    "Incident state is unavailable or invalid; admission is frozen fail-closed.",
  ticket: "AMUX_INCIDENT_STATE_INVALID",
});

const isCanonicalInstant = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
};

export const parseAmuxIncidentSetting = (
  raw: string | null | undefined,
  now = new Date(),
): AmuxIncidentReading => {
  if (raw === null || raw === undefined) {
    const state = failClosedState(now);
    return { state, valid: false, blocks_admission: true, problem: "missing" };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    const state = failClosedState(now);
    return {
      state,
      valid: false,
      blocks_admission: true,
      problem: "invalid_json",
    };
  }

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !==
      AMUX_INCIDENT_SETTING_VERSION ||
    !AMUX_INCIDENT_STATES.includes(
      (value as Record<string, unknown>).state as AmuxIncidentStateName,
    ) ||
    !(
      (value as Record<string, unknown>).transition_id === null ||
      (typeof (value as Record<string, unknown>).transition_id === "string" &&
        ((value as Record<string, unknown>).transition_id as string).length > 0)
    ) ||
    !isCanonicalInstant((value as Record<string, unknown>).changed_at) ||
    typeof (value as Record<string, unknown>).reason !== "string" ||
    ((value as Record<string, unknown>).reason as string).trim().length < 3 ||
    typeof (value as Record<string, unknown>).ticket !== "string" ||
    ((value as Record<string, unknown>).ticket as string).trim().length < 1
  ) {
    const state = failClosedState(now);
    return {
      state,
      valid: false,
      blocks_admission: true,
      problem: "invalid_shape",
    };
  }

  const state = value as AmuxIncidentState;
  return {
    state,
    valid: true,
    blocks_admission: state.state === "frozen",
    problem: null,
  };
};

export const serializeAmuxIncidentState = (state: AmuxIncidentState) =>
  JSON.stringify(state);
