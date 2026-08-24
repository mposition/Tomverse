"use client";

import { useId } from "react";

import { interpolate } from "@/components/imports/importFormatting";
import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";
import { ENABLED_MODELS } from "@/lib/models";

/**
 * The models a profile may start with.
 *
 * docs/policy/external-conversation-import-and-memory.md §14.0, §14.0a.
 *
 * Lifted out of `AssistantProfileEditor` when the package import wizard needed
 * the same control. It is the same question in both places -- which models
 * does this profile start with, up to the profile's own ceiling -- and a
 * second copy would be a second place for that ceiling to be enforced
 * differently.
 *
 * One control, not two: `profileVersionProblems` puts no floor on the list, so
 * "this assistant names no model of its own" is an answer both screens can
 * give, and a second control that refused it would make the same profile valid
 * on one screen and invalid on the other.
 *
 * `testIdPrefix` exists because the two screens are separate specs: an
 * assertion written for the editor should not pass because the wizard
 * happened to render a control with the same id.
 *
 * `interpolate` comes from the external import's formatting helpers rather
 * than from a copy of its own, for the reason stated there: it is pure and
 * locale-agnostic, and two definitions of the same substitution is how two
 * screens stop agreeing about it.
 */

/**
 * Whether the profile names its own models (§14.0a).
 *
 * `account-default` stores an empty list — the assistant makes no model
 * choice and a conversation started from it opens on the account's own
 * new-conversation selection, resolved when the conversation is created
 * rather than pinned when the profile was.
 */
export type ModelMode = "account-default" | "explicit";

/**
 * Whether this assistant names its own models, and which.
 *
 * ## Why "no model" is a choice and not an empty selection
 *
 * A profile's model list is a *starting* selection: §14.0 applies it when a
 * conversation is created and nowhere else, and the user is free to change
 * models afterwards without touching the assistant. So naming none is the
 * ordinary case — the conversation opens on the account's own default, and it
 * keeps doing that after that default changes.
 *
 * That state used to be unreachable. The create screen filled the account's
 * default in, so every assistant pinned whatever model the account had on the
 * day it was made; unticking the last box then sent an empty list to a server
 * that required one and answered `Invalid request payload.`, with no field
 * named. Two checkboxes cannot express "follow the account" either — an empty
 * list reads as an unanswered question, not an answer.
 *
 * Hence a radio: the two states are named, the default one is selected, and
 * the list appears only when the user has said they want to choose. Inside
 * that mode the last model cannot be unticked — the way out is the other
 * radio, which says what unticking everything was trying to say.
 */
export function ModelSelector({
    label,
    hint,
    mode,
    onModeChange,
    selected,
    onChange,
    t,
    testIdPrefix = "assistant",
}: {
    label: string;
    hint: string;
    mode: ModelMode;
    onModeChange: (next: ModelMode) => void;
    selected: string[];
    onChange: (next: string[]) => void;
    t: (key: string) => string;
    testIdPrefix?: string;
}) {
    const atLimit = selected.length >= ASSISTANT_PROFILE_LIMITS.maxModels;
    const modeName = useId();
    return (
        <fieldset
            className="flex flex-col gap-2"
            data-testid={`${testIdPrefix}-models`}
        >
            <legend className="text-sm font-semibold">{label}</legend>
            <p className="text-xs text-zinc-500">{hint}</p>

            <label className="flex items-start gap-2 text-sm">
                <input
                    type="radio"
                    name={modeName}
                    className="mt-1"
                    checked={mode === "account-default"}
                    onChange={() => onModeChange("account-default")}
                    data-testid={`${testIdPrefix}-model-mode-default`}
                />
                <span>
                    {t("assistantProfiles.modelModeDefault")}
                    <span className="block text-xs font-normal text-zinc-500">
                        {t("assistantProfiles.modelModeDefaultHint")}
                    </span>
                </span>
            </label>

            <label className="flex items-start gap-2 text-sm">
                <input
                    type="radio"
                    name={modeName}
                    className="mt-1"
                    checked={mode === "explicit"}
                    onChange={() => onModeChange("explicit")}
                    data-testid={`${testIdPrefix}-model-mode-explicit`}
                />
                <span>{t("assistantProfiles.modelModeExplicit")}</span>
            </label>

            {mode === "explicit" && (
                <div className="ml-6 flex flex-col gap-2">
                    <p className="text-xs text-zinc-500">
                        {interpolate(t("assistantProfiles.modelsLimitHint"), {
                            max: ASSISTANT_PROFILE_LIMITS.maxModels,
                        })}
                    </p>
                    {ENABLED_MODELS.map((model) => {
                        const checked = selected.includes(model.id);
                        // The last one cannot be unticked, because an empty
                        // explicit selection is not a state this screen has:
                        // it is the other radio.
                        const isLastSelected = checked && selected.length === 1;
                        return (
                            <label
                                key={model.id}
                                className="flex items-center gap-2 text-sm"
                            >
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    // The ceiling is enforced by refusing to
                                    // add, not by dropping silently: a user
                                    // who ticks one model too many should
                                    // find out here rather than discover
                                    // later that one of their choices went
                                    // missing.
                                    disabled={
                                        isLastSelected || (!checked && atLimit)
                                    }
                                    onChange={(event) =>
                                        onChange(
                                            event.target.checked
                                                ? [...selected, model.id]
                                                : selected.filter(
                                                      (id) => id !== model.id
                                                  )
                                        )
                                    }
                                    data-testid={`${testIdPrefix}-model-${model.id}`}
                                />
                                <span>{model.name}</span>
                            </label>
                        );
                    })}
                    <p
                        className="text-xs text-zinc-500"
                        data-testid={`${testIdPrefix}-models-keep-one`}
                    >
                        {t("assistantProfiles.modelsKeepOne")}
                    </p>
                </div>
            )}
        </fieldset>
    );
}
