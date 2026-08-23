"use client";

import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";
import { ENABLED_MODELS } from "@/lib/models";

/**
 * The models a profile may start with.
 *
 * Lifted out of `AssistantProfileEditor` when the package import wizard needed
 * the same control. It is the same question in both places -- which models
 * does this profile start with, up to the profile's own ceiling -- and a
 * second copy would be a second place for that ceiling to be enforced
 * differently.
 *
 * `testIdPrefix` exists because the two screens are separate specs: an
 * assertion written for the editor should not pass because the wizard
 * happened to render a control with the same id.
 */
export function ModelSelector({
    label,
    hint,
    selected,
    onChange,
    testIdPrefix = "assistant",
}: {
    label: string;
    hint: string;
    selected: string[];
    onChange: (next: string[]) => void;
    testIdPrefix?: string;
}) {
    const atLimit = selected.length >= ASSISTANT_PROFILE_LIMITS.maxModels;
    return (
        <fieldset
            className="flex flex-col gap-2"
            data-testid={`${testIdPrefix}-models`}
        >
            <legend className="text-sm font-semibold">{label}</legend>
            <p className="text-xs text-zinc-500">{hint}</p>
            {ENABLED_MODELS.map((model) => {
                const checked = selected.includes(model.id);
                return (
                    <label
                        key={model.id}
                        className="flex items-center gap-2 text-sm"
                    >
                        <input
                            type="checkbox"
                            checked={checked}
                            // The ceiling is enforced by refusing to add, not
                            // by dropping silently: a user who ticks a fourth
                            // model should find out here rather than discover
                            // later that one of their choices went missing.
                            disabled={!checked && atLimit}
                            onChange={(event) =>
                                onChange(
                                    event.target.checked
                                        ? [...selected, model.id]
                                        : selected.filter((id) => id !== model.id)
                                )
                            }
                            data-testid={`${testIdPrefix}-model-${model.id}`}
                        />
                        <span>{model.name}</span>
                    </label>
                );
            })}
        </fieldset>
    );
}
