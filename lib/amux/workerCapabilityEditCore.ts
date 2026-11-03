import {
  amuxWorkerCapabilitiesEqual,
  amuxWorkerCapabilityRefusal,
  type AmuxWorkerCapability,
  type AmuxWorkerCapabilityAdminRow,
  type AmuxWorkerCapabilityRefusal,
} from "./workerCapabilityCore.ts";
import {
  amuxWorkerDefaultProfilePreset,
  amuxWorkerProfilePresetCapability,
  amuxWorkerProfilePresetOf,
  amuxWorkerProfilePresetsFor,
  type AmuxWorkerProfilePreset,
} from "./workerProfilePresetCore.ts";

/**
 * Orchestration policy version 35, section 2 (stage R2a, "Admin 편집"; version
 * 36): the owner's edit form for one worker's capability in AMUX › Operations
 * settings › Workers. Since the owner decision of 2026-10-27 the form is a
 * preset, one model and whether AMUX hands the worker Tasks of its own; the
 * lists are the preset's (lib/amux/workerProfilePresetCore.ts). Pure: the
 * form's state, the capability it describes, and the refusal the store would
 * give it, so the screen says why before sending. The route and the store
 * check the same rule again; this is a preview.
 */

export type AmuxWorkerCapabilityForm = {
  workerName: string;
  /** The recorded revision the change is made against (0 when none is). */
  expectedRevision: number;
  preset: AmuxWorkerProfilePreset;
  /** One model: the worker's, and its one-shot model when it takes Tasks. */
  model: string;
  /** Whether AMUX hands this worker one-shot Tasks (a v22 profile). */
  oneShot: boolean;
};

/**
 * The form for a row, from what is recorded: its preset, or the ceiling's when
 * the record matches none (saving then rewrites it as that preset).
 */
export function amuxWorkerCapabilityFormFromRow(row: AmuxWorkerCapabilityAdminRow): AmuxWorkerCapabilityForm {
  const capability = row.current?.capability ?? null;
  return {
    workerName: row.workerName,
    expectedRevision: row.current?.revision ?? 0,
    preset: amuxWorkerProfilePresetOf(row, capability) ?? amuxWorkerDefaultProfilePreset(row),
    model: capability?.v22?.model ?? capability?.model ?? "",
    oneShot: capability?.v22 != null,
  };
}

/** The capability the form describes for this worker. */
export function amuxWorkerCapabilityFromForm(
  row: AmuxWorkerCapabilityAdminRow,
  form: AmuxWorkerCapabilityForm,
): AmuxWorkerCapability {
  return amuxWorkerProfilePresetCapability(row, form.preset, form.model, form.oneShot);
}

/** Why the store would refuse the form for this row, or null. */
export function amuxWorkerCapabilityFormRefusal(
  row: AmuxWorkerCapabilityAdminRow,
  form: AmuxWorkerCapabilityForm,
): AmuxWorkerCapabilityRefusal | "preset_unavailable" | null {
  if (!amuxWorkerProfilePresetsFor(row).includes(form.preset)) return "preset_unavailable";
  const registration = {
    workerName: row.workerName,
    providerClass: row.providerClass,
    roleCeiling: row.roleCeiling,
    desiredState: row.desiredState,
    revision: 0,
  };
  return amuxWorkerCapabilityRefusal(registration, amuxWorkerCapabilityFromForm(row, form));
}

/** Whether saving the form would change what is recorded. */
export function amuxWorkerCapabilityFormChanges(
  row: AmuxWorkerCapabilityAdminRow,
  form: AmuxWorkerCapabilityForm,
): boolean {
  return !amuxWorkerCapabilitiesEqual(row.current?.capability ?? null, amuxWorkerCapabilityFromForm(row, form));
}

/** Whether what is recorded is no preset at all ("custom"). */
export function amuxWorkerCapabilityIsCustom(row: AmuxWorkerCapabilityAdminRow): boolean {
  const capability = row.current?.capability ?? null;
  return capability !== null && amuxWorkerProfilePresetOf(row, capability) === null;
}
