"use client";

import { useLanguage } from "@/components/LanguageProvider";
import { interpolate } from "@/components/imports/importFormatting";
import {
    EXTERNAL_IMPORT_WIZARD_STEPS,
    type ExternalImportWizardStepId,
} from "@/lib/externalImportWizard";

/**
 * The five-step progress display.
 *
 * This is a *status* readout, not navigation: the items are list items with
 * no button or link semantics, because a step the user cannot jump to must
 * not look like something they can click. Going back is a real "Back" button
 * in the step body, offered only from states where stepping back is safe.
 *
 * Screen readers get the same thing sighted users get: the container is
 * labelled "Import progress", the current item carries `aria-current="step"`,
 * and each item's accessible name is the full "Step 3 of 5, Choose
 * conversations" sentence rather than a bare label.
 */

const STEP_LABEL_KEYS: Record<ExternalImportWizardStepId, string> = {
    prepare_export: "externalImport.stepPrepareExport",
    inspect_file: "externalImport.stepInspectFile",
    select_conversations: "externalImport.stepSelectConversations",
    confirm_import: "externalImport.stepConfirmImport",
    done: "externalImport.stepDone",
};

export function ImportStepIndicator({
    currentStep,
}: {
    currentStep: ExternalImportWizardStepId;
}) {
    const { t } = useLanguage();
    const currentIndex = EXTERNAL_IMPORT_WIZARD_STEPS.indexOf(currentStep);
    const total = EXTERNAL_IMPORT_WIZARD_STEPS.length;

    return (
        <ol
            aria-label={t("externalImport.stepIndicatorLabel")}
            className="flex flex-wrap items-center gap-x-2 gap-y-1"
            data-testid="external-import-step-indicator"
        >
            {EXTERNAL_IMPORT_WIZARD_STEPS.map((step, index) => {
                const isCurrent = step === currentStep;
                const isDone = index < currentIndex;
                const label = t(STEP_LABEL_KEYS[step]);
                return (
                    <li
                        key={step}
                        aria-current={isCurrent ? "step" : undefined}
                        aria-label={interpolate(
                            t("externalImport.stepPosition"),
                            { current: index + 1, total, name: label }
                        )}
                        data-step={step}
                        data-state={
                            isCurrent ? "current" : isDone ? "done" : "upcoming"
                        }
                        className={`flex items-center gap-1.5 text-xs font-semibold ${
                            isCurrent
                                ? "text-zinc-900 dark:text-zinc-100"
                                : "text-zinc-400"
                        }`}
                    >
                        <span
                            aria-hidden="true"
                            className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                                isCurrent
                                    ? "bg-blue-600 text-white"
                                    : isDone
                                      ? "bg-status-success-500 text-white"
                                      : "bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                            }`}
                        >
                            {index + 1}
                        </span>
                        <span aria-hidden="true">{label}</span>
                    </li>
                );
            })}
        </ol>
    );
}
