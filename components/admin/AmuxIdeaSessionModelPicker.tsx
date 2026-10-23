"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import type { AvailableFrontierModel } from "@/lib/amux/ideaFrontierCatalogUiCore";
import type { AmuxOperatingScope } from "@/lib/amux/ideaOperatingScopeCore";
import {
  chooseSessionModel, sessionModelKey, type SessionModelChoice,
} from "@/lib/amux/ideaSessionModelChoiceCore";

const selectClass = "min-h-11 rounded-lg border px-3 border-zinc-600 bg-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300";

/**
 * The unattended analysis model for one idea: the operating scope's model by
 * default, or another approved Frontier model at one of its allowed efforts.
 * Presentational: the panel owns the model list read and the choice.
 */
export function AmuxIdeaSessionModelPicker({ models, scopeModel, choice, disabled, onChange }: {
  models: readonly AvailableFrontierModel[] | null | "error";
  scopeModel: AmuxOperatingScope["model"] | undefined;
  choice: SessionModelChoice; disabled: boolean;
  onChange: (choice: SessionModelChoice) => void;
}) {
  const messages = useAdminMessages(adminAmuxIdeaInputMessages);
  const list = Array.isArray(models) ? models : null;
  const chosen = list?.find((model) => sessionModelKey(model) === choice.key) ?? null;
  const scopeLabel = scopeModel
    ? `${messages.sessionModelScopeDefault} (${scopeModel.modelId} · ${scopeModel.reasoningEffort})`
    : messages.sessionModelScopeDefault;
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="amux-idea-session-model">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1">{messages.sessionModelLabel}
          <select value={choice.key} disabled={disabled || !list} className={selectClass}
            onChange={(event) => onChange(chooseSessionModel(list, event.target.value))}>
            <option value="">{scopeLabel}</option>
            {list?.map((model) => (
              <option key={model.approvalId} value={sessionModelKey(model)}>{model.provider} / {model.modelId}</option>
            ))}
          </select>
        </label>
        {chosen ? (
          <label className="flex flex-col gap-1">{messages.sessionModelEffort}
            <select value={choice.effort} disabled={disabled} className={selectClass}
              onChange={(event) => onChange({ key: choice.key, effort: event.target.value })}>
              {chosen.allowedEfforts.map((effort: string) => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      <p className="text-xs text-zinc-400">
        {models === "error" ? messages.sessionModelUnavailable : messages.sessionModelHint}
      </p>
    </div>
  );
}
