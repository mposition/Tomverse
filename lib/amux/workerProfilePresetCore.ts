/**
 * Worker profile presets (owner decision 2026-10-27). A worker's routing tags,
 * tools, v22 roles and v22 tools are the same for every worker of one role, so
 * the owner picks the role and a model instead of typing each list. The
 * provider rules are applied when the preset is expanded: a tag or role the
 * worker's class or ceiling cannot hold is left out, so a preset never asks for
 * something the store would refuse.
 *
 * Pure. What is stored is still a plain capability
 * (lib/amux/workerCapabilityCore.ts); a preset is how the screen writes one.
 */

import {
  AMUX_WORKER_ROUTING_TAG_REQUIREMENTS,
  AMUX_WORKER_V22_ROLE_REQUIREMENTS,
  amuxWorkerCapabilitiesEqual,
  amuxWorkerMeetsRequirement,
  type AmuxWorkerCapability,
} from "./workerCapabilityCore.ts";
import {
  amuxV22ProviderForClass,
  amuxV22ProviderRoleSupported,
  amuxV22RequiredTool,
} from "./v22WorkerClaimCore.ts";
import {
  AMUX_WORKER_PROVIDER_CLASS_TABLE,
  amuxWorkerRoleRank,
  type AmuxWorkerProviderClass,
  type AmuxWorkerRoleCeiling,
} from "./workerRegistryCore.ts";

export const AMUX_WORKER_PROFILE_PRESETS = ["chore", "impl", "contract", "review"] as const;
export type AmuxWorkerProfilePreset = (typeof AMUX_WORKER_PROFILE_PRESETS)[number];

type PresetDefinition = Readonly<{
  /** The lowest role ceiling the preset is offered at. */
  ceiling: AmuxWorkerRoleCeiling;
  /** Offered only to a verified class: its whole point is a review. */
  verifiedOnly: boolean;
  routingTags: readonly string[];
  tools: readonly string[];
  v22Roles: readonly string[];
}>;

const WRITE_TOOLS = Object.freeze(["repo_read", "repo_write", "test_run"]);

export const AMUX_WORKER_PROFILE_PRESET_TABLE: Readonly<Record<AmuxWorkerProfilePreset, PresetDefinition>> =
  Object.freeze({
    chore: Object.freeze({
      ceiling: "chore", verifiedOnly: false,
      routingTags: ["bugfix", "chore", "tests"], tools: WRITE_TOOLS, v22Roles: ["investigate"],
    }),
    impl: Object.freeze({
      ceiling: "implementation", verifiedOnly: false,
      routingTags: ["bugfix", "implementation", "integration", "multi_file", "tests"], tools: WRITE_TOOLS,
      v22Roles: ["implement", "investigate"],
    }),
    contract: Object.freeze({
      ceiling: "contract", verifiedOnly: false,
      routingTags: ["architecture", "contract", "multi_file", "reasoning", "review", "security"], tools: WRITE_TOOLS,
      v22Roles: ["design", "implement", "investigate", "review"],
    }),
    review: Object.freeze({
      ceiling: "contract", verifiedOnly: true,
      routingTags: ["architecture", "reasoning", "review", "security"], tools: ["repo_read"],
      v22Roles: ["investigate", "review"],
    }),
  });

type Worker = { providerClass: AmuxWorkerProviderClass; roleCeiling: AmuxWorkerRoleCeiling };

/** The presets this worker may be given, lowest first. */
export function amuxWorkerProfilePresetsFor(worker: Worker): AmuxWorkerProfilePreset[] {
  const verified = AMUX_WORKER_PROVIDER_CLASS_TABLE[worker.providerClass].verified;
  return AMUX_WORKER_PROFILE_PRESETS.filter((preset) => {
    const definition = AMUX_WORKER_PROFILE_PRESET_TABLE[preset];
    return amuxWorkerRoleRank(definition.ceiling) <= amuxWorkerRoleRank(worker.roleCeiling) &&
      (!definition.verifiedOnly || verified);
  });
}

/** The preset a worker starts with: the one its ceiling names. */
export function amuxWorkerDefaultProfilePreset(worker: Worker): AmuxWorkerProfilePreset {
  return worker.roleCeiling === "chore" ? "chore" : worker.roleCeiling === "implementation" ? "impl" : "contract";
}

/**
 * The capability a preset writes for this worker: the preset's lists without
 * what the class or ceiling cannot hold. One model, written as both the
 * worker's model and its v22 model. `oneShot` false records no v22 profile;
 * so does a preset none of whose v22 roles this worker can take.
 */
export function amuxWorkerProfilePresetCapability(
  worker: Worker,
  preset: AmuxWorkerProfilePreset,
  model: string,
  oneShot: boolean,
): AmuxWorkerCapability {
  const definition = AMUX_WORKER_PROFILE_PRESET_TABLE[preset];
  const registration = { ...worker, workerName: "", desiredState: "active" as const, revision: 1 };
  const routingTags = definition.routingTags.filter((tag) =>
    amuxWorkerMeetsRequirement(registration, AMUX_WORKER_ROUTING_TAG_REQUIREMENTS[tag]!));
  const name = model.trim();
  const provider = amuxV22ProviderForClass(worker.providerClass);
  const roles = provider === null ? [] : definition.v22Roles.filter((role) =>
    amuxWorkerMeetsRequirement(registration, AMUX_WORKER_V22_ROLE_REQUIREMENTS[role]!) &&
    amuxV22ProviderRoleSupported(provider, role));
  const tools = [...new Set(roles.map((role) => amuxV22RequiredTool(role)!))].sort();
  return {
    model: name.length > 0 ? name : null,
    routingTags: [...routingTags].sort(),
    toolCapabilities: [...definition.tools].sort(),
    v22: oneShot && roles.length > 0 ? { model: name, roles: [...roles].sort(), tools } : null,
  };
}

/**
 * The preset a recorded capability is, or null when it is none of them (a
 * "custom" record from before presets, or one edited by hand).
 */
export function amuxWorkerProfilePresetOf(
  worker: Worker,
  capability: AmuxWorkerCapability | null,
): AmuxWorkerProfilePreset | null {
  if (capability === null) return null;
  const model = capability.v22?.model ?? capability.model ?? "";
  if (capability.v22 !== null && capability.model !== null && capability.model !== capability.v22.model) return null;
  return amuxWorkerProfilePresetsFor(worker).find((preset) =>
    amuxWorkerCapabilitiesEqual(capability,
      amuxWorkerProfilePresetCapability(worker, preset, model, capability.v22 !== null))) ?? null;
}
