/**
 * Copy for the Auto routing control, in the seven languages the model picker
 * supports.
 *
 * Kept beside `lib/modelPickerPresentation.ts` rather than inside it: this
 * vocabulary belongs to a rollout that is off, and folding it into the
 * picker's own record would mean every future picker change carries strings
 * for a feature nobody can see yet.
 *
 * ## What the copy is allowed to promise
 *
 * The hardest line here is the one under the toggle. Auto picks a model per
 * turn, and a user who reads that as "Tomverse now picks the best model" will
 * read every answer they dislike as the router's fault. So the description
 * says what actually happens -- the model is chosen for each message, and the
 * name of the one that answered is shown on the message itself -- and nothing
 * about better, smarter or optimal.
 *
 * The reason strings are the same discipline. `selectionReason` is a fixed
 * identifier from `lib/routerSelection.ts`, and each is translated to a plain
 * statement of what the router did. None of them says the choice was right.
 */

export type AutoRoutingLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";

export type AutoRoutingCopy = {
  /** The control's own label. */
  label: string;
  /** Compact picker label; its accessible name still announces the full mode and action. */
  compactLabel: string;
  /** One line under it. Says what happens, never how well. */
  description: string;
  /** Shown on the picker row while Auto is on, in place of a model name. */
  activeSummary: string;
  /** The stored manual choice remains available, but is not the active answer model. */
  manualFallbackLabel: string;
  /** Explains why a model is still listed while Auto is active. */
  manualFallbackDescription: string;
  /** Auto cannot quote the stored manual model's price as its own estimate. */
  variableCreditLabel: string;
  variableCreditNotice: string;
  /** Announced when the mode changes, for a screen reader. */
  turnedOn: string;
  turnedOff: string;
  /** Neutral selection label on an assistant message that Auto routed. */
  answeredBy: string;
};

export const autoRoutingCopy: Record<AutoRoutingLanguage, AutoRoutingCopy> = {
  en: {
    label: "Smart Adaptive",
    compactLabel: "Auto",
    description:
      "Tomverse picks a model for each message. The one that answered is shown on the reply.",
    activeSummary: "Smart Adaptive — a model is chosen per message",
    manualFallbackLabel: "Manual return model",
    manualFallbackDescription: "Used after Smart Adaptive is turned off.",
    variableCreditLabel: "Variable",
    variableCreditNotice: "Credits depend on the model that answers.",
    turnedOn: "Smart Adaptive is on. A model will be chosen for each message.",
    turnedOff: "Smart Adaptive is off. Your selected model answers every message.",
    answeredBy: "Auto selected",
  },
  ko: {
    label: "스마트 자동",
    compactLabel: "자동",
    description:
      "메시지마다 Tomverse가 모델을 고릅니다. 답변한 모델은 답변에 표시됩니다.",
    activeSummary: "스마트 자동 — 메시지마다 모델을 고릅니다",
    manualFallbackLabel: "수동 전환 모델",
    manualFallbackDescription: "스마트 자동을 끄면 이 모델을 사용합니다.",
    variableCreditLabel: "변동",
    variableCreditNotice: "답변한 모델에 따라 크레딧이 달라집니다.",
    turnedOn: "스마트 자동이 켜졌습니다. 메시지마다 모델을 고릅니다.",
    turnedOff: "스마트 자동이 꺼졌습니다. 선택한 모델이 모든 메시지에 답변합니다.",
    answeredBy: "자동 선택",
  },
  zh: {
    label: "智能自动",
    compactLabel: "自动",
    description: "Tomverse 会为每条消息挑选模型。回答的模型会显示在回复上。",
    activeSummary: "智能自动 — 每条消息挑选一个模型",
    manualFallbackLabel: "手动模式模型",
    manualFallbackDescription: "关闭智能自动后使用此模型。",
    variableCreditLabel: "浮动",
    variableCreditNotice: "额度取决于回答的模型。",
    turnedOn: "智能自动已开启。每条消息都会挑选一个模型。",
    turnedOff: "智能自动已关闭。你选择的模型将回答所有消息。",
    answeredBy: "自动选择",
  },
  fr: {
    label: "Adaptation intelligente",
    compactLabel: "Auto",
    description:
      "Tomverse choisit un modèle pour chaque message. Celui qui a répondu est indiqué sur la réponse.",
    activeSummary: "Adaptation intelligente — un modèle est choisi par message",
    manualFallbackLabel: "Modèle de retour manuel",
    manualFallbackDescription: "Utilisé après la désactivation de l’adaptation intelligente.",
    variableCreditLabel: "Variable",
    variableCreditNotice: "Les crédits dépendent du modèle qui répond.",
    turnedOn: "L’adaptation intelligente est activée. Un modèle sera choisi pour chaque message.",
    turnedOff: "L’adaptation intelligente est désactivée. Le modèle que vous avez choisi répond à tous les messages.",
    answeredBy: "Sélection automatique",
  },
  de: {
    label: "Intelligente Automatik",
    compactLabel: "Auto",
    description:
      "Tomverse wählt für jede Nachricht ein Modell. Das antwortende Modell steht an der Antwort.",
    activeSummary: "Intelligente Automatik — pro Nachricht wird ein Modell gewählt",
    manualFallbackLabel: "Modell für den manuellen Modus",
    manualFallbackDescription: "Wird nach dem Ausschalten der intelligenten Automatik verwendet.",
    variableCreditLabel: "Variabel",
    variableCreditNotice: "Die Credits hängen vom antwortenden Modell ab.",
    turnedOn: "Die intelligente Automatik ist an. Für jede Nachricht wird ein Modell gewählt.",
    turnedOff: "Die intelligente Automatik ist aus. Das von dir gewählte Modell beantwortet jede Nachricht.",
    answeredBy: "Automatisch ausgewählt",
  },
  es: {
    label: "Adaptación inteligente",
    compactLabel: "Auto",
    description:
      "Tomverse elige un modelo para cada mensaje. El que respondió aparece en la respuesta.",
    activeSummary: "Adaptación inteligente — se elige un modelo por mensaje",
    manualFallbackLabel: "Modelo para el modo manual",
    manualFallbackDescription: "Se usa después de desactivar la adaptación inteligente.",
    variableCreditLabel: "Variable",
    variableCreditNotice: "Los créditos dependen del modelo que responda.",
    turnedOn: "La adaptación inteligente está activada. Se elegirá un modelo para cada mensaje.",
    turnedOff: "La adaptación inteligente está desactivada. El modelo que elegiste responde a todos los mensajes.",
    answeredBy: "Selección automática",
  },
  pt: {
    label: "Adaptação inteligente",
    compactLabel: "Auto",
    description:
      "O Tomverse escolhe um modelo para cada mensagem. O que respondeu aparece na resposta.",
    activeSummary: "Adaptação inteligente — um modelo é escolhido por mensagem",
    manualFallbackLabel: "Modelo para o modo manual",
    manualFallbackDescription: "Usado após desligar a adaptação inteligente.",
    variableCreditLabel: "Variável",
    variableCreditNotice: "Os créditos dependem do modelo que responder.",
    turnedOn: "A adaptação inteligente está ligada. Um modelo será escolhido para cada mensagem.",
    turnedOff: "A adaptação inteligente está desligada. O modelo que você escolheu responde a todas as mensagens.",
    answeredBy: "Seleção automática",
  },
};

/**
 * The router's fixed selection reasons, as sentences.
 *
 * `lib/routerSelection.ts` owns the identifiers; this owns how each is said.
 * `no_candidate` deliberately has no entry: it is a refusal, so it never
 * reaches a routed message. An identifier with no entry falls back to `null`
 * rather than to its raw form, because `fallback_order` rendered into a
 * user's chat is a leak of internal vocabulary, not a translation.
 */
export const autoRoutingReasonCopy: Record<
  AutoRoutingLanguage,
  Readonly<Record<string, string>>
> = {
  en: {
    only_candidate: "the only model available for this message",
    task_preference: "chosen for this kind of message",
    fallback_order: "no model was a better fit for this message",
    sticky: "kept from your previous message",
  },
  ko: {
    only_candidate: "이 메시지에 사용할 수 있는 유일한 모델",
    task_preference: "이런 종류의 메시지에 맞춰 선택됨",
    fallback_order: "이 메시지에 더 잘 맞는 모델이 없었음",
    sticky: "이전 메시지에서 이어짐",
  },
  zh: {
    only_candidate: "这条消息唯一可用的模型",
    task_preference: "针对这类消息挑选",
    fallback_order: "没有更适合这条消息的模型",
    sticky: "沿用上一条消息",
  },
  fr: {
    only_candidate: "le seul modèle disponible pour ce message",
    task_preference: "choisi pour ce type de message",
    fallback_order: "aucun modèle ne convenait mieux à ce message",
    sticky: "conservé depuis votre message précédent",
  },
  de: {
    only_candidate: "das einzige für diese Nachricht verfügbare Modell",
    task_preference: "für diese Art von Nachricht gewählt",
    fallback_order: "kein Modell passte besser zu dieser Nachricht",
    sticky: "aus deiner vorigen Nachricht übernommen",
  },
  es: {
    only_candidate: "el único modelo disponible para este mensaje",
    task_preference: "elegido para este tipo de mensaje",
    fallback_order: "ningún modelo encajaba mejor con este mensaje",
    sticky: "mantenido desde tu mensaje anterior",
  },
  pt: {
    only_candidate: "o único modelo disponível para esta mensagem",
    task_preference: "escolhido para este tipo de mensagem",
    fallback_order: "nenhum modelo se encaixava melhor nesta mensagem",
    sticky: "mantido da sua mensagem anterior",
  },
};

export const autoRoutingReason = (
  language: AutoRoutingLanguage,
  reason: string | null | undefined
): string | null => {
  if (!reason) return null;
  return autoRoutingReasonCopy[language][reason] ?? null;
};
