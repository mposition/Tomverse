import type { Language } from "@/components/LanguageProvider";

// The mobile header shows "GPT-5.4 mini +2". "+2" on its own is meaningless to
// a screen reader, so the button carries a full sentence naming the model on
// screen AND the total number of models that will actually answer (STG-F009).
// This lives next to chatHelpCopy.ts rather than in locales/*.ts because it is
// a single composed sentence per language, not a set of reusable UI strings.

export type ChatModelSummaryLabelInput = {
  primaryModelName: string | null;
  /** Active models other than the one named above. */
  extraActiveCount: number;
  activeCount: number;
  pausedCount: number;
};

export type ChatModelSummaryCopy = {
  /** Standalone label for the picker-opening affordance. */
  openPicker: string;
  /** Complete accessible name for the header summary button. */
  accessibleName: (input: ChatModelSummaryLabelInput) => string;
  /**
   * The whole visible label of the compact multi-model header entry point --
   * "3 models". The model tab strip immediately below already names every
   * model and marks the one on screen, so repeating a model name up here only
   * costs a header row. The full selection stays in `accessibleName`.
   */
  compactLabel: (activeCount: number) => string;
};

const plural = (count: number, singular: string, pluralForm: string) =>
  count === 1 ? singular : pluralForm;

export const chatModelSummaryCopy: Record<Language, ChatModelSummaryCopy> = {
  ko: {
    openPicker: "모델 선택기 열기",
    accessibleName: ({ primaryModelName, extraActiveCount, activeCount, pausedCount }) => {
      if (!primaryModelName) return "선택된 모델이 없습니다. 모델 선택기 열기.";
      const selection =
        extraActiveCount > 0
          ? `${primaryModelName} 외 ${extraActiveCount}개 모델 선택됨.`
          : `${primaryModelName} 선택됨.`;
      const paused = pausedCount > 0 ? ` 일시정지 ${pausedCount}개.` : "";
      return `${selection} 활성 모델 총 ${activeCount}개.${paused} 모델 선택기 열기.`;
    },
    compactLabel: (activeCount) => `${activeCount}개 모델`,
  },
  en: {
    openPicker: "Open model picker",
    accessibleName: ({ primaryModelName, extraActiveCount, activeCount, pausedCount }) => {
      if (!primaryModelName) return "No models selected. Open model picker.";
      const selection =
        extraActiveCount > 0
          ? `${primaryModelName} and ${extraActiveCount} more ${plural(extraActiveCount, "model", "models")} selected.`
          : `${primaryModelName} selected.`;
      const paused =
        pausedCount > 0
          ? ` ${pausedCount} ${plural(pausedCount, "model", "models")} paused.`
          : "";
      return `${selection} ${activeCount} active ${plural(activeCount, "model", "models")} total.${paused} Open model picker.`;
    },
    compactLabel: (activeCount) => `${activeCount} ${plural(activeCount, "model", "models")}`,
  },
  zh: {
    openPicker: "打开模型选择器",
    accessibleName: ({ primaryModelName, extraActiveCount, activeCount, pausedCount }) => {
      if (!primaryModelName) return "未选择模型。打开模型选择器。";
      const selection =
        extraActiveCount > 0
          ? `已选择 ${primaryModelName} 等 ${extraActiveCount + 1} 个模型。`
          : `已选择 ${primaryModelName}。`;
      const paused = pausedCount > 0 ? ` 已暂停 ${pausedCount} 个。` : "";
      return `${selection}当前活跃模型共 ${activeCount} 个。${paused}打开模型选择器。`;
    },
    compactLabel: (activeCount) => `${activeCount} 个模型`,
  },
  fr: {
    openPicker: "Ouvrir le sélecteur de modèles",
    accessibleName: ({ primaryModelName, extraActiveCount, activeCount, pausedCount }) => {
      if (!primaryModelName) return "Aucun modèle sélectionné. Ouvrir le sélecteur de modèles.";
      const selection =
        extraActiveCount > 0
          ? `${primaryModelName} et ${extraActiveCount} autre${extraActiveCount > 1 ? "s" : ""} modèle${extraActiveCount > 1 ? "s" : ""} sélectionné${extraActiveCount > 1 ? "s" : ""}.`
          : `${primaryModelName} sélectionné.`;
      const paused =
        pausedCount > 0
          ? ` ${pausedCount} modèle${pausedCount > 1 ? "s" : ""} en pause.`
          : "";
      return `${selection} ${activeCount} modèle${activeCount > 1 ? "s" : ""} actif${activeCount > 1 ? "s" : ""} au total.${paused} Ouvrir le sélecteur de modèles.`;
    },
    compactLabel: (activeCount) => `${activeCount} modèle${activeCount > 1 ? "s" : ""}`,
  },
  de: {
    openPicker: "Modellauswahl öffnen",
    accessibleName: ({ primaryModelName, extraActiveCount, activeCount, pausedCount }) => {
      if (!primaryModelName) return "Keine Modelle ausgewählt. Modellauswahl öffnen.";
      const selection =
        extraActiveCount > 0
          ? `${primaryModelName} und ${extraActiveCount} weitere${extraActiveCount > 1 ? "" : "s"} Modell${extraActiveCount > 1 ? "e" : ""} ausgewählt.`
          : `${primaryModelName} ausgewählt.`;
      const paused =
        pausedCount > 0
          ? ` ${pausedCount} Modell${pausedCount > 1 ? "e" : ""} pausiert.`
          : "";
      return `${selection} Insgesamt ${activeCount} aktive${activeCount > 1 ? "" : "s"} Modell${activeCount > 1 ? "e" : ""}.${paused} Modellauswahl öffnen.`;
    },
    compactLabel: (activeCount) => `${activeCount} Modell${activeCount > 1 ? "e" : ""}`,
  },
  es: {
    openPicker: "Abrir el selector de modelos",
    accessibleName: ({ primaryModelName, extraActiveCount, activeCount, pausedCount }) => {
      if (!primaryModelName) return "Ningún modelo seleccionado. Abrir el selector de modelos.";
      const selection =
        extraActiveCount > 0
          ? `${primaryModelName} y ${extraActiveCount} modelo${extraActiveCount > 1 ? "s" : ""} más seleccionado${extraActiveCount > 1 ? "s" : ""}.`
          : `${primaryModelName} seleccionado.`;
      const paused =
        pausedCount > 0
          ? ` ${pausedCount} modelo${pausedCount > 1 ? "s" : ""} en pausa.`
          : "";
      return `${selection} ${activeCount} modelo${activeCount > 1 ? "s" : ""} activo${activeCount > 1 ? "s" : ""} en total.${paused} Abrir el selector de modelos.`;
    },
    compactLabel: (activeCount) => `${activeCount} modelo${activeCount > 1 ? "s" : ""}`,
  },
  pt: {
    openPicker: "Abrir o seletor de modelos",
    accessibleName: ({ primaryModelName, extraActiveCount, activeCount, pausedCount }) => {
      if (!primaryModelName) return "Nenhum modelo selecionado. Abrir o seletor de modelos.";
      const selection =
        extraActiveCount > 0
          ? `${primaryModelName} e mais ${extraActiveCount} modelo${extraActiveCount > 1 ? "s" : ""} selecionado${extraActiveCount > 1 ? "s" : ""}.`
          : `${primaryModelName} selecionado.`;
      const paused =
        pausedCount > 0
          ? ` ${pausedCount} modelo${pausedCount > 1 ? "s" : ""} pausado${pausedCount > 1 ? "s" : ""}.`
          : "";
      return `${selection} ${activeCount} modelo${activeCount > 1 ? "s" : ""} ativo${activeCount > 1 ? "s" : ""} no total.${paused} Abrir o seletor de modelos.`;
    },
    compactLabel: (activeCount) => `${activeCount} modelo${activeCount > 1 ? "s" : ""}`,
  },
};
