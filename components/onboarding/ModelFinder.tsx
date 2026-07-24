"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Gauge,
  Sparkles,
  X,
} from "lucide-react";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { useLanguage } from "@/components/LanguageProvider";
import {
  getModelFinderCombination,
  getModelFinderPromptKey,
  type ModelFinderComboPick,
  type ModelFinderPriority,
  type ModelFinderTask,
} from "@/lib/modelFinder";
import { MODEL_FINDER_OPEN_EVENT } from "@/lib/modelFinderEvents";
import { getModelUsageProfile } from "@/lib/models";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import {
  trackProductEvent,
  trackProductEventOnce,
} from "@/lib/productAnalyticsClient";
import { notifyUserSettingsUpdated } from "@/lib/userSettingsEvents";

type ModelFinderProps = {
  enabled: boolean;
  onComplete: (result: {
    modelIds: string[];
    promptExample?: string;
  }) => void;
};

type Stage = "intro" | "tasks" | "priority" | "result";

const taskOptions: Array<{ value: ModelFinderTask; label: string }> = [
  { value: "documents", label: "modelFinder.taskDocuments" },
  { value: "writing", label: "modelFinder.taskWriting" },
  { value: "coding", label: "modelFinder.taskCoding" },
  { value: "research", label: "modelFinder.taskResearch" },
  { value: "multilingual", label: "modelFinder.taskMultilingual" },
  { value: "general", label: "modelFinder.taskGeneral" },
];

const priorityOptions: Array<{
  value: ModelFinderPriority;
  label: string;
}> = [
  { value: "fast", label: "modelFinder.priorityFast" },
  { value: "balanced", label: "modelFinder.priorityBalanced" },
  { value: "deep", label: "modelFinder.priorityDeep" },
  { value: "sources", label: "modelFinder.prioritySources" },
];

const stageNumber = (stage: Stage) => (stage === "tasks" ? 1 : 2);

export function ModelFinder({ enabled, onComplete }: ModelFinderProps) {
  const { getModel } = useModelCatalog();
  const { t, lang } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("intro");
  const [tasks, setTasks] = useState<ModelFinderTask[]>([]);
  const [priority, setPriority] = useState<ModelFinderPriority | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(
    new Set()
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  const answers = useMemo(
    () => (tasks.length > 0 && priority ? { tasks, priority } : null),
    [priority, tasks]
  );
  const combo = useMemo<ModelFinderComboPick[]>(
    () => (answers ? getModelFinderCombination(answers) : []),
    [answers]
  );
  const selectedTotalCredits = useMemo(
    () =>
      combo
        .filter((pick) => selectedModelIds.has(pick.modelId))
        .reduce((total, pick) => {
          const model = getModel(pick.modelId);
          return model ? total + getModelUsageProfile(model).credits : total;
        }, 0),
    [combo, getModel, selectedModelIds]
  );

  const reset = useCallback(() => {
    setStage("intro");
    setTasks([]);
    setPriority(null);
    setSelectedModelIds(new Set());
    setError("");
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const handleOpen = () => {
      reset();
      setIsOpen(true);
      trackProductEvent("model_finder_viewed", 0, {
        method: "on_demand",
      });
    };
    window.addEventListener(MODEL_FINDER_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(MODEL_FINDER_OPEN_EVENT, handleOpen);
  }, [enabled, reset]);

  useEffect(() => {
    const advanced = combo.find((pick) => pick.role === "advanced");
    if (stage !== "result" || !advanced) return;
    trackProductEventOnce(
      `model_finder_advanced_${advanced.modelId}_v1`,
      "advanced_model_suggested",
      1,
      {
        model_id: advanced.modelId,
        suggestion_reason:
          advanced.reasonKey === "modelFinder.optionalResearch"
            ? "research"
            : "deep_analysis",
      }
    );
  }, [combo, stage]);

  const saveAction = async (body: Record<string, unknown>) => {
    setIsSaving(true);
    setError("");
    try {
      const response = await fetch("/api/user/model-finder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => null)) as {
        defaultModelId?: string;
      } | null;
      if (!response.ok || !data?.defaultModelId) {
        throw new Error(`Model finder save failed: ${response.status}`);
      }
      return data.defaultModelId;
    } finally {
      setIsSaving(false);
    }
  };

  const handleUseDefault = async () => {
    try {
      const defaultModelId = await saveAction({ action: "accept_default" });
      trackProductEvent("model_finder_skipped", 0, { method: "default" });
      trackProductEvent("recommended_model_accepted", 1, {
        model_id: defaultModelId,
        recommendation_rank: 1,
        method: "default",
      });
      notifyUserSettingsUpdated({ defaultModel: defaultModelId });
      onComplete({
        modelIds: [defaultModelId],
        promptExample: t("modelFinder.prompts.general"),
      });
      setIsOpen(false);
    } catch (saveError) {
      console.error(saveError);
      setError(t("modelFinder.saveFailed"));
    }
  };

  const handleComplete = async (saveAsDefault: boolean) => {
    if (!answers || selectedModelIds.size === 0) return;
    const modelIds = combo
      .filter((pick) => selectedModelIds.has(pick.modelId))
      .map((pick) => pick.modelId);
    const promptExample = t(
      getModelFinderPromptKey({ ...answers, fileUsage: "rarely" })
    );

    // "Use for this conversation" applies the combination locally without
    // writing it to the account's saved default -- only "Save as default
    // combination" persists anything server-side.
    if (!saveAsDefault) {
      trackProductEvent("model_finder_completed", modelIds.length, {
        model_id: modelIds[0],
        method: "once",
      });
      onComplete({ modelIds, promptExample });
      setIsOpen(false);
      return;
    }

    try {
      const defaultModelId = await saveAction({
        action: "complete",
        answers,
        modelIds,
      });
      trackProductEvent("model_finder_completed", modelIds.length, {
        model_id: defaultModelId,
        method: "save",
      });
      trackProductEvent("recommended_model_accepted", 1, {
        model_id: defaultModelId,
        recommendation_rank: 1,
      });
      notifyUserSettingsUpdated({ defaultModel: defaultModelId });
      onComplete({ modelIds, promptExample });
      setIsOpen(false);
    } catch (saveError) {
      console.error(saveError);
      setError(t("modelFinder.saveFailed"));
    }
  };

  if (!enabled || !isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-5">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-finder-title"
        data-testid="model-finder"
        className="relative flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 sm:rounded-3xl"
      >
        <button
          type="button"
          data-testid="model-finder-close"
          onClick={() => setIsOpen(false)}
          aria-label={t("chat.close")}
          className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-5 sm:p-7">
          {stage === "intro" ? (
            <div className="mx-auto max-w-xl py-3 text-center sm:py-8">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-500/25">
                <Sparkles className="h-7 w-7" />
              </span>
              <h2
                id="model-finder-title"
                className="mt-5 text-2xl font-black tracking-tight text-zinc-950 dark:text-white sm:text-3xl"
              >
                {t("modelFinder.title")}
              </h2>
              <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                {t("modelFinder.description")}
              </p>
              <div className="mt-7 space-y-3 text-left">
                <button
                  type="button"
                  onClick={() => {
                    setStage("tasks");
                    trackProductEvent("model_finder_started", 0);
                  }}
                  className="flex w-full items-center justify-between rounded-2xl bg-blue-600 px-5 py-4 text-sm font-black text-white transition hover:bg-blue-500"
                >
                  {t("modelFinder.start")}
                  <ChevronRight className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => void handleUseDefault()}
                  className="w-full rounded-2xl border border-zinc-200 px-5 py-3.5 text-sm font-bold text-zinc-800 transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  {t("modelFinder.useDefault")}
                </button>
              </div>
            </div>
          ) : stage === "result" ? (
            <div>
              <div className="text-center">
                <span className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-black text-emerald-600 dark:text-emerald-400">
                  <Check className="h-3.5 w-3.5" />
                  {t("modelFinder.primary")}
                </span>
                <h2
                  id="model-finder-title"
                  className="mt-3 text-2xl font-black text-zinc-950 dark:text-white"
                >
                  {t("modelFinder.resultTitle")}
                </h2>
                <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-zinc-500">
                  {t("modelFinder.resultDescription")}
                </p>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                {combo.map((pick) => {
                  const model = getModel(pick.modelId);
                  if (!model) return null;
                  const isSelected = selectedModelIds.has(pick.modelId);
                  const isAdvanced = pick.role === "advanced";
                  const usageProfile = getModelUsageProfile(model);
                  return (
                    <button
                      key={pick.modelId}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => {
                        setSelectedModelIds((current) => {
                          const next = new Set(current);
                          if (next.has(pick.modelId)) {
                            next.delete(pick.modelId);
                          } else {
                            next.add(pick.modelId);
                          }
                          return next;
                        });
                        if (!isSelected) {
                          trackProductEvent(
                            "advanced_model_selected",
                            combo.length,
                            { model_id: pick.modelId }
                          );
                        }
                      }}
                      className={`rounded-2xl border p-4 text-left transition ${
                        isSelected
                          ? isAdvanced
                            ? "border-amber-400 bg-amber-50 ring-2 ring-amber-400/20 dark:bg-amber-950/20"
                            : "border-blue-500 bg-blue-50 ring-2 ring-blue-500/20 dark:bg-blue-950/20"
                          : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                      }`}
                    >
                      <span className="flex items-start gap-3">
                        <ModelLogo model={model} size="md" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-black text-zinc-950 dark:text-white">
                            {model.name}
                          </span>
                          <span
                            className={`mt-0.5 block text-[10px] font-black uppercase tracking-wider ${
                              isAdvanced ? "text-amber-600" : "text-blue-500"
                            }`}
                          >
                            {t(`modelFinder.roles.${pick.role}`)}
                          </span>
                        </span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black ${
                            isSelected
                              ? "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-200"
                              : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                          }`}
                        >
                          {t(
                            isSelected
                              ? "modelFinder.includeInSet"
                              : "modelFinder.excludeFromSet"
                          )}
                        </span>
                      </span>
                      <span className="mt-3 block text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                        {t(pick.reasonKey)}
                      </span>
                      <CreditCostBadge
                        credits={usageProfile.credits}
                        size="xs"
                        className="mt-2"
                        label={
                          lang === "ko"
                            ? `기본 ${usageProfile.credits}크레딧 차감`
                            : `Base cost ${usageProfile.credits} credits`
                        }
                        testId="model-finder-credit-cost"
                      />
                      {isAdvanced && (
                        <span className="mt-2 block text-[11px] leading-5 text-amber-700 dark:text-amber-300">
                          {t("modelFinder.freeAdvancedQuota")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <p
                data-testid="model-finder-estimated-total"
                className="mt-4 text-center text-xs font-bold text-zinc-500 dark:text-zinc-400"
              >
                {t("modelFinder.estimatedTotal").replace(
                  "{credits}",
                  String(selectedTotalCredits)
                )}
              </p>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={isSaving || selectedModelIds.size === 0}
                  onClick={() => void handleComplete(false)}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 py-4 text-sm font-black text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {isSaving ? t("modelFinder.saving") : t("modelFinder.useOnce")}
                  {!isSaving && <ChevronRight className="h-5 w-5" />}
                </button>
                <button
                  type="button"
                  disabled={isSaving || selectedModelIds.size === 0}
                  onClick={() => void handleComplete(true)}
                  className="w-full rounded-2xl border border-zinc-200 px-5 py-4 text-sm font-bold text-zinc-800 transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  {t("modelFinder.saveAsDefault")}
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setStage(stage === "tasks" ? "intro" : "tasks")}
                  aria-label={t("modelFinder.back")}
                  className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-black uppercase tracking-wider text-blue-500">
                    {t("modelFinder.progress").replaceAll(
                      "{current}",
                      String(stageNumber(stage))
                    )}
                  </p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all"
                      style={{ width: `${(stageNumber(stage) / 2) * 100}%` }}
                    />
                  </div>
                </div>
              </div>

              <h2
                id="model-finder-title"
                className="mt-7 text-2xl font-black text-zinc-950 dark:text-white"
              >
                {t(
                  stage === "tasks"
                    ? "modelFinder.tasksTitle"
                    : "modelFinder.priorityTitle"
                )}
              </h2>
              {stage === "tasks" && (
                <p className="mt-1 text-sm text-zinc-500">
                  {t("modelFinder.tasksHint")}
                </p>
              )}

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {stage === "tasks" &&
                  taskOptions.map((option) => {
                    const selected = tasks.includes(option.value);
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          setTasks((current) =>
                            current.includes(option.value)
                              ? current.filter((task) => task !== option.value)
                              : [...current, option.value]
                          )
                        }
                        className={`flex items-center gap-3 rounded-2xl border p-4 text-left text-sm font-bold transition ${
                          selected
                            ? "border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-950/20 dark:text-blue-200"
                            : "border-zinc-200 text-zinc-700 hover:border-zinc-400 dark:border-zinc-800 dark:text-zinc-300"
                        }`}
                      >
                        <span
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                            selected
                              ? "border-blue-500 bg-blue-500 text-white"
                              : "border-zinc-300 dark:border-zinc-700"
                          }`}
                        >
                          {selected && <Check className="h-3.5 w-3.5" />}
                        </span>
                        {t(option.label)}
                      </button>
                    );
                  })}
                {stage === "priority" &&
                  priorityOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={priority === option.value}
                      onClick={() => setPriority(option.value)}
                      className={`flex items-center gap-3 rounded-2xl border p-4 text-left text-sm font-bold transition ${
                        priority === option.value
                          ? "border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-950/20 dark:text-blue-200"
                          : "border-zinc-200 text-zinc-700 hover:border-zinc-400 dark:border-zinc-800 dark:text-zinc-300"
                      }`}
                    >
                      <Gauge className="h-5 w-5 shrink-0" />
                      {t(option.label)}
                    </button>
                  ))}
              </div>

              <button
                type="button"
                disabled={
                  (stage === "tasks" && tasks.length === 0) ||
                  (stage === "priority" && !priority)
                }
                onClick={() => {
                  if (stage === "tasks") setStage("priority");
                  if (stage === "priority") {
                    const nextAnswers =
                      tasks.length > 0 && priority ? { tasks, priority } : null;
                    const nextCombo = nextAnswers
                      ? getModelFinderCombination(nextAnswers)
                      : [];
                    setSelectedModelIds(
                      new Set(nextCombo.map((pick) => pick.modelId))
                    );
                    setStage("result");
                  }
                }}
                className="mt-7 flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 py-4 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("modelFinder.next")}
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-4 text-center text-sm font-bold text-red-500">
              {error}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
