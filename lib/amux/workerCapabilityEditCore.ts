import {
  amuxWorkerCapabilitiesEqual,
  amuxWorkerCapabilityRefusal,
  type AmuxWorkerCapability,
  type AmuxWorkerCapabilityAdminRow,
  type AmuxWorkerCapabilityRefusal,
} from "./workerCapabilityCore.ts";
import { amuxWorkerProviderClassOf } from "./workerRegistryCore.ts";

/**
 * Orchestration policy version 35, section 2 (stage R2a, "Admin 편집"; version
 * 36): the owner's edit form for one worker's capability in AMUX › Execution ›
 * Workers. Pure: the form's state, the capability it describes, and the
 * refusal the store would give it, so the screen says why before sending.
 * The route and the store check the same rule again; this is a preview.
 */

export type AmuxWorkerCapabilityForm = {
  workerName: string;
  /** The recorded revision the change is made against (0 when none is). */
  expectedRevision: number;
  model: string;
  routingTags: string[];
  /** Tools as typed: comma-separated. */
  tools: string;
  /**
   * The recorded tools. While `tools` still reads exactly as they were
   * shown, these are kept as they are -- a recorded tool may itself contain
   * a comma, which splitting the text would change.
   */
  recordedTools: string[];
  v22Enabled: boolean;
  v22Model: string;
  v22Roles: string[];
  v22Tools: string[];
};

const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();

/** The form for a row, filled from what is recorded (empty when nothing is). */
export function amuxWorkerCapabilityFormFromRow(row: AmuxWorkerCapabilityAdminRow): AmuxWorkerCapabilityForm {
  const capability = row.current?.capability ?? null;
  return {
    workerName: row.workerName,
    expectedRevision: row.current?.revision ?? 0,
    model: capability?.model ?? "",
    routingTags: [...(capability?.routingTags ?? [])],
    tools: (capability?.toolCapabilities ?? []).join(", "),
    recordedTools: [...(capability?.toolCapabilities ?? [])],
    v22Enabled: capability?.v22 != null,
    v22Model: capability?.v22?.model ?? "",
    v22Roles: [...(capability?.v22?.roles ?? [])],
    v22Tools: [...(capability?.v22?.tools ?? [])],
  };
}

/** The capability the form describes. Blank model is no model; tools are split on commas. */
export function amuxWorkerCapabilityFromForm(form: AmuxWorkerCapabilityForm): AmuxWorkerCapability {
  const model = form.model.trim();
  return {
    model: model.length > 0 ? model : null,
    routingTags: sortedUnique(form.routingTags),
    toolCapabilities: form.tools === form.recordedTools.join(", ")
      ? sortedUnique(form.recordedTools)
      : sortedUnique(form.tools.split(",").map((tool) => tool.trim()).filter((tool) => tool.length > 0)),
    v22: form.v22Enabled
      ? { model: form.v22Model.trim(), roles: sortedUnique(form.v22Roles), tools: sortedUnique(form.v22Tools) }
      : null,
  };
}

/** Why the store would refuse the form for this row, or null. */
export function amuxWorkerCapabilityFormRefusal(
  row: AmuxWorkerCapabilityAdminRow,
  form: AmuxWorkerCapabilityForm,
): AmuxWorkerCapabilityRefusal | null {
  const providerClass = amuxWorkerProviderClassOf(row.workerName);
  const registration = providerClass === null ? null : {
    workerName: row.workerName,
    providerClass,
    roleCeiling: row.roleCeiling,
    desiredState: row.desiredState,
    revision: 0,
  };
  return amuxWorkerCapabilityRefusal(registration, amuxWorkerCapabilityFromForm(form));
}

/** Whether saving the form would change what is recorded. */
export function amuxWorkerCapabilityFormChanges(
  row: AmuxWorkerCapabilityAdminRow,
  form: AmuxWorkerCapabilityForm,
): boolean {
  return !amuxWorkerCapabilitiesEqual(row.current?.capability ?? null, amuxWorkerCapabilityFromForm(form));
}

/** Toggles one value in a list, keeping the list sorted and unique. */
export const amuxToggleListValue = (values: readonly string[], value: string, on: boolean): string[] =>
  sortedUnique(on ? [...values, value] : values.filter((item) => item !== value));
