"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  FileText,
  Gauge,
  SearchCheck,
  Sparkles,
} from "lucide-react";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { useLanguage } from "@/components/LanguageProvider";
import {
  getModelFinderPromptKey,
  getModelFinderRecommendations,
  getOptionalModelSuggestion,
  type ModelFinderAnswers,
  type ModelFinderFileUsage,
  type ModelFinderPriority,
  type ModelFinderTask,
} from "@/lib/modelFinder";
import { MODEL_FINDER_OPEN_EVENT } from "@/lib/modelFinderEvents";
import { getModel, getModelUsageProfile } from "@/lib/models";
import {
  trackProductEvent,
  trackProductEventOnce,
} from "@/lib/productAnalyticsClient";
import { notifyUserSettingsUpdated } from "@/lib/userSettingsEvents";

const VARIANT_STORAGE_KEY = "tomverse_model_finder_variant_v1";

type ModelFinderProps = {
  enabled: boolean;
  userId: string | null;
  onComplete: (result: {
    defaultModelId: string;
    optionalModelId?: string;
    promptExample?: string;
  }) => void;
};

type Stage = "intro" | "tasks" | "priority" | "files" | "result";

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

const fileOptions: Array<{
  value: ModelFinderFileUsage;
  label: string;
}> = [
  { value: "documents", label: "modelFinder.filesDocuments" },
  { value: "images", label: "modelFinder.filesImages" },
  { value: "rarely", label: "modelFinder.filesRarely" },
];

const stageNumber = (stage: Stage) =>
  stage === "tasks" ? 1 : stage === "priority" ? 2 : 3;

export function ModelFinder({ enabled, userId, onComplete }: ModelFinderProps) {
  const { t } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("intro");
  const [tasks, setTasks] = useState<ModelFinderTask[]>([]);
  const [priority, setPriority] = useState<ModelFinderPriority | null>(null);
  const [fileUsage, setFileUsage] = useState<ModelFinderFileUsage | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [includeOptionalModel, setIncludeOptionalModel] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const requestedUserIdRef = useRef<string | null>(null);

  const answers = useMemo<ModelFinderAnswers | null>(
    () =>
      tasks.length > 0 && priority && fileUsage
        ? { tasks, priority, fileUsage }
        : null,
    [fileUsage, priority, tasks]
  );
  const recommendations = useMemo(
    () => (answers ? getModelFinderRecommendations(answers) : []),
    [answers]
  );
  const optionalSuggestion = useMemo(
    () => (answers ? getOptionalModelSuggestion(answers) : null),
    [answers]
  );

  const formatCopy = useCallback(
    (key: string, values: Record<string, string>) =>
      Object.entries(values).reduce(
        (copy, [name, value]) => copy.replaceAll(`{${name}}`, value),
        t(key)
      ),
    [t]
  );

  const reset = useCallback(() => {
    setStage("intro");
    setTasks([]);
    setPriority(null);
    setFileUsage(null);
    setSelectedModelId(null);
    setIncludeOptionalModel(false);
    setError("");
  }, []);

  useEffect(() => {
    if (!enabled || !userId || requestedUserIdRef.current === userId) return;
    requestedUserIdRef.current = userId;
    let cancelled = false;

    fetch("/api/user/model-finder", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Model finder load failed: ${response.status}`);
        return response.json() as Promise<{
          variant?: "control" | "finder";
          shouldShow?: boolean;
        }>;
      })
      .then((data) => {
        if (cancelled) return;
        if (data.variant === "control" || data.variant === "finder") {
          window.localStorage.setItem(VARIANT_STORAGE_KEY, data.variant);
        }
        if (data.shouldShow) {
          reset();
          setIsOpen(true);
          trackProductEventOnce(
            "model_finder_initial_view_v1",
            "model_finder_viewed",
            0,
            { experiment_variant: "finder" }
          );
        }
      })
      .catch((loadError) => {
        console.error("Failed to load model finder:", loadError);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, reset, userId]);

  useEffect(() => {
    if (!enabled) return;
    const handleOpen = () => {
      reset();
      setIsOpen(true);
      trackProductEvent("model_finder_viewed", 0, {
        method: "settings",
      });
    };
    window.addEventListener(MODEL_FINDER_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(MODEL_FINDER_OPEN_EVENT, handleOpen);
  }, [enabled, reset]);

  useEffect(() => {
    if (stage !== "result" || !optionalSuggestion) return;
    trackProductEventOnce(
      `model_finder_optional_${optionalSuggestion.modelId}_v1`,
      "advanced_model_suggested",
      1,
      {
        model_id: optionalSuggestion.modelId,
        suggestion_reason: optionalSuggestion.reason,
      }
    );
  }, [optionalSuggestion, stage]);

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

  const handleSkip = async (method: "later" | "default") => {
    try {
      const defaultModelId = await saveAction({
        action: method === "default" ? "accept_default" : "skip",
      });
      trackProductEvent("model_finder_skipped", 0, { method });
      if (method === "default") {
        trackProductEvent("recommended_model_accepted", 1, {
          model_id: defaultModelId,
          recommendation_rank: 1,
          method: "default",
        });
        notifyUserSettingsUpdated({ defaultModel: defaultModelId });
        onComplete({
          defaultModelId,
          promptExample: t("modelFinder.prompts.general"),
        });
      }
      setIsOpen(false);
    } catch (saveError) {
      console.error(saveError);
      setError(t("modelFinder.saveFailed"));
    }
  };

  const handleComplete = async () => {
    if (!answers || !selectedModelId) return;
    const recommendationRank =
      recommendations.findIndex(
        (recommendation) => recommendation.modelId === selectedModelId
      ) + 1;
    try {
      const defaultModelId = await saveAction({
        action: "complete",
        answers,
        defaultModelId: selectedModelId,
      });
      trackProductEvent("model_finder_completed", 1, {
        model_id: defaultModelId,
        recommendation_rank: Math.max(1, recommendationRank),
      });
      trackProductEvent("recommended_model_accepted", 1, {
        model_id: defaultModelId,
        recommendation_rank: Math.max(1, recommendationRank),
      });
      notifyUserSettingsUpdated({ defaultModel: defaultModelId });
      onComplete({
        defaultModelId,
        ...(includeOptionalModel && optionalSuggestion
          ? { optionalModelId: optionalSuggestion.modelId }
          : {}),
        promptExample: t(getModelFinderPromptKey(answers)),
      });
      setIsOpen(false);
    } catch (saveError) {
      console.error(saveError);
      setError(t("modelFinder.saveFailed"));
    }
  };

  if (!enabled || !isOpen) return null;

  const selectedRecommendation =
    recommendations.find(
      (recommendation) => recommendation.modelId === selectedModelId
    ) || recommendations[0];
  const optionalModel = optionalSuggestion
    ? getModel(optionalSuggestion.modelId)
    : undefined;
  const optionalProfile = optionalModel
    ? getModelUsageProfile(optionalModel)
    : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-5">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-finder-title"
        data-testid="model-finder"
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 sm:rounded-3xl"
      >
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
                  onClick={() => void handleSkip("default")}
                  className="w-full rounded-2xl border border-zinc-200 px-5 py-3.5 text-sm font-bold text-zinc-800 transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  {t("modelFinder.useDefault")}
                </button>
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => void handleSkip("later")}
                  className="w-full px-5 py-2 text-sm font-semibold text-zinc-500 hover:text-zinc-900 disabled:opacity-50 dark:hover:text-white"
                >
                  {t("modelFinder.later")}
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
                {recommendations.map((recommendation, index) => {
                  const model = getModel(recommendation.modelId);
                  const isSelected =
                    recommendation.modelId === selectedRecommendation?.modelId;
                  if (!model) return null;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => {
                        setSelectedModelId(model.id);
                        if (selectedRecommendation?.modelId !== model.id) {
                          trackProductEvent("recommended_model_changed", 1, {
                            model_id: model.id,
                            recommendation_rank: index + 1,
                          });
                        }
                      }}
                      className={`rounded-2xl border p-4 text-left transition ${
                        isSelected
                          ? "border-blue-500 bg-blue-50 ring-2 ring-blue-500/20 dark:bg-blue-950/20"
                          : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <ModelLogo model={model} size="md" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-black text-zinc-950 dark:text-white">
                            {model.name}
                          </span>
                          <span className="block text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                            {t("modelFinder.standardBadge")}
                          </span>
                        </span>
                        {isSelected && <Check className="h-5 w-5 text-blue-500" />}
                      </span>
                      <span className="mt-3 block text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                        {t(recommendation.reasonKey)}
                      </span>
                    </button>
                  );
                })}
              </div>

              {optionalSuggestion && optionalModel && optionalProfile && (
                <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900/60 dark:bg-amber-950/20">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      {optionalSuggestion.reason === "research" ? (
                        <SearchCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                      ) : (
                        <FileText className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                      )}
                      <div>
                        <p className="text-sm font-black text-zinc-950 dark:text-white">
                          {t("modelFinder.optionalTitle")}: {optionalModel.name}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-300">
                          {t(
                            optionalSuggestion.reason === "research"
                              ? "modelFinder.optionalResearch"
                              : "modelFinder.optionalDeep"
                          )}
                        </p>
                        <p className="mt-1 text-[11px] font-bold text-amber-700 dark:text-amber-300">
                          {optionalProfile.category} · {optionalProfile.credits} credits
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-pressed={includeOptionalModel}
                      onClick={() => {
                        const next = !includeOptionalModel;
                        setIncludeOptionalModel(next);
                        if (next) {
                          trackProductEvent("advanced_model_selected", 2, {
                            model_id: optionalModel.id,
                            suggestion_reason: optionalSuggestion.reason,
                          });
                        }
                      }}
                      className={`shrink-0 rounded-xl px-4 py-2.5 text-xs font-black transition ${
                        includeOptionalModel
                          ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-950"
                          : "border border-amber-300 bg-white text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-zinc-950 dark:text-amber-200"
                      }`}
                    >
                      {t(
                        includeOptionalModel
                          ? "modelFinder.optionalRemove"
                          : "modelFinder.optionalUse"
                      )}
                    </button>
                  </div>
                  <p className="mt-3 text-[11px] leading-5 text-zinc-500">
                    {t("modelFinder.freeAdvancedQuota")}
                  </p>
                </div>
              )}

              <button
                type="button"
                disabled={isSaving || !selectedRecommendation}
                onClick={() => void handleComplete()}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 py-4 text-sm font-black text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {isSaving ? t("modelFinder.saving") : t("modelFinder.useThisModel")}
                {!isSaving && <ChevronRight className="h-5 w-5" />}
              </button>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                    setStage(
                      stage === "tasks"
                        ? "intro"
                        : stage === "priority"
                          ? "tasks"
                          : "priority"
                    )
                  }
                  aria-label={t("modelFinder.back")}
                  className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 text-zinc-500 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-black uppercase tracking-wider text-blue-500">
                    {formatCopy("modelFinder.progress", {
                      current: String(stageNumber(stage)),
                    })}
                  </p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all"
                      style={{ width: `${(stageNumber(stage) / 3) * 100}%` }}
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
                    : stage === "priority"
                      ? "modelFinder.priorityTitle"
                      : "modelFinder.filesTitle"
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
                {stage === "files" &&
                  fileOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={fileUsage === option.value}
                      onClick={() => setFileUsage(option.value)}
                      className={`flex items-center gap-3 rounded-2xl border p-4 text-left text-sm font-bold transition sm:col-span-2 ${
                        fileUsage === option.value
                          ? "border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-950/20 dark:text-blue-200"
                          : "border-zinc-200 text-zinc-700 hover:border-zinc-400 dark:border-zinc-800 dark:text-zinc-300"
                      }`}
                    >
                      <FileText className="h-5 w-5 shrink-0" />
                      {t(option.label)}
                    </button>
                  ))}
              </div>

              <button
                type="button"
                disabled={
                  (stage === "tasks" && tasks.length === 0) ||
                  (stage === "priority" && !priority) ||
                  (stage === "files" && !fileUsage)
                }
                onClick={() => {
                  if (stage === "tasks") setStage("priority");
                  if (stage === "priority") setStage("files");
                  if (stage === "files") {
                    const nextAnswers =
                      tasks.length > 0 && priority && fileUsage
                        ? { tasks, priority, fileUsage }
                        : null;
                    const nextRecommendations = nextAnswers
                      ? getModelFinderRecommendations(nextAnswers)
                      : [];
                    setSelectedModelId(nextRecommendations[0]?.modelId || null);
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
