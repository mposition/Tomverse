"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { interpolate } from "@/components/imports/importFormatting";
import {
    applyModelSwap,
    planModelSelectionChange,
} from "@/lib/continuationModelPanels";
import { canUseModelWithPlan, type AiModel, type ModelTier } from "@/lib/models";

/**
 * Which models answer the next turn of a continued conversation.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.3.
 *
 * ## What this component does not decide
 *
 * The cap, availability and entitlement. All three are the server's, exactly
 * as they are for any other Review conversation: this control sends
 * `selectedModels` to `PATCH /api/conversations/[conversationId]` and that
 * route clamps against the runtime catalogue and answers
 * `PLAN_MODEL_LIMIT_EXCEEDED` above the plan's limit. There is no
 * continuation-specific limit and no continuation-specific error code.
 *
 * `maxModels` arrives as a prop resolved on the server -- the same
 * `effectivePlanModelLimit()` the PATCH route applies. It is here so the
 * screen can ask *which model to replace* before sending a change the server
 * would refuse, not so the client can decide the answer.
 *
 * ## Why the cap asks instead of substituting
 *
 * At the cap, choosing another model is ambiguous: the owner has said which
 * one they want and not which one they are done with. Swapping silently picks
 * for them, and what it picks changes what every later turn costs. So the
 * control asks, and until it is answered the selection is unchanged.
 */

export function ContinuationModelSelector({
    selected,
    maxModels,
    planTier,
    saving,
    errorMessage,
    onChange,
}: {
    selected: string[];
    maxModels: number;
    planTier: ModelTier;
    saving: boolean;
    errorMessage: string | null;
    onChange: (modelIds: string[]) => void;
}) {
    const { t } = useLanguage();
    const { publicModels } = useModelCatalog();
    const [pendingSwap, setPendingSwap] = useState<string | null>(null);
    const [refusal, setRefusal] = useState<string | null>(null);

    const choose = (model: AiModel) => {
        setRefusal(null);
        const plan = planModelSelectionChange({
            selected,
            modelId: model.id,
            maxModels,
        });
        if (plan.kind === "refused") {
            setRefusal(t("continuation.modelsLastOne"));
            return;
        }
        if (plan.kind === "swap_required") {
            setPendingSwap(plan.incomingModelId);
            return;
        }
        onChange(plan.modelIds);
    };

    const incoming = pendingSwap
        ? publicModels.find((model) => model.id === pendingSwap)
        : undefined;

    return (
        <div data-testid="continuation-model-selector">
            <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">
                {t("continuation.modelsTitle")}
            </p>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
                {interpolate(t("continuation.modelsLimit"), { max: maxModels })}
            </p>
            <ul className="mt-2 flex flex-wrap gap-2">
                {publicModels.map((model) => {
                    const isSelected = selected.includes(model.id);
                    // The plan's own reach, read from the same predicate the
                    // rest of the application reads it from. A model the plan
                    // cannot use is shown and refused rather than hidden, so
                    // the catalogue is the same everywhere.
                    const allowed = canUseModelWithPlan(planTier, model);
                    return (
                        <li key={model.id}>
                            <button
                                type="button"
                                data-testid="continuation-model-option"
                                data-model-id={model.id}
                                aria-pressed={isSelected}
                                disabled={saving || !allowed}
                                title={
                                    allowed ? undefined : t("continuation.modelsPlanLocked")
                                }
                                onClick={() => choose(model)}
                                className={`inline-flex min-h-11 items-center gap-1.5 rounded-xl border px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                    isSelected
                                        ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                                        : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
                                }`}
                            >
                                {isSelected ? (
                                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                ) : null}
                                {model.name}
                            </button>
                        </li>
                    );
                })}
            </ul>

            {saving ? (
                <p className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    {t("continuation.modelsSaving")}
                </p>
            ) : null}

            {refusal ? (
                <p
                    className="mt-2 text-xs leading-5 text-red-600 dark:text-red-300"
                    role="status"
                    data-testid="continuation-model-refusal"
                >
                    {refusal}
                </p>
            ) : null}

            {errorMessage ? (
                <p
                    className="mt-2 text-xs leading-5 text-red-600 dark:text-red-300"
                    role="status"
                    data-testid="continuation-model-error"
                >
                    {errorMessage}
                </p>
            ) : null}

            {incoming ? (
                <div
                    className="mt-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"
                    data-testid="continuation-model-swap"
                    role="group"
                    aria-label={t("continuation.modelsSwapTitle")}
                >
                    <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                        {interpolate(t("continuation.modelsSwapTitle"), {
                            model: incoming.name,
                        })}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-zinc-500">
                        {t("continuation.modelsSwapHint")}
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-2">
                        {selected.map((modelId) => {
                            const outgoing = publicModels.find(
                                (model) => model.id === modelId
                            );
                            return (
                                <li key={modelId}>
                                    <button
                                        type="button"
                                        data-testid="continuation-model-swap-option"
                                        data-model-id={modelId}
                                        className="inline-flex min-h-11 items-center rounded-xl border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
                                        onClick={() => {
                                            onChange(
                                                applyModelSwap({
                                                    selected,
                                                    outgoingModelId: modelId,
                                                    incomingModelId: incoming.id,
                                                })
                                            );
                                            setPendingSwap(null);
                                        }}
                                    >
                                        {outgoing?.name ?? modelId}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    <button
                        type="button"
                        className="mt-2 min-h-11 text-sm font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                        data-testid="continuation-model-swap-cancel"
                        onClick={() => setPendingSwap(null)}
                    >
                        {t("continuation.cancel")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
