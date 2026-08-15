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
  /** One line under it. Says what happens, never how well. */
  description: string;
  /** Shown on the picker row while Auto is on, in place of a model name. */
  activeSummary: string;
  /** Announced when the mode changes, for a screen reader. */
  turnedOn: string;
  turnedOff: string;
  /** Prefix on an assistant message that Auto routed. */
  answeredBy: string;
};

export const autoRoutingCopy: Record<AutoRoutingLanguage, AutoRoutingCopy> = {
  en: {
    label: "Auto",
    description:
      "Tomverse picks a model for each message. The one that answered is shown on the reply.",
    activeSummary: "Auto — a model is chosen per message",
    turnedOn: "Auto is on. A model will be chosen for each message.",
    turnedOff: "Auto is off. Your selected model answers every message.",
    answeredBy: "Answered by",
  },
  ko: {
    label: "자동",
    description:
      "메시지마다 Tomverse가 모델을 고릅니다. 답변한 모델은 답변에 표시됩니다.",
    activeSummary: "자동 — 메시지마다 모델을 고릅니다",
    turnedOn: "자동이 켜졌습니다. 메시지마다 모델을 고릅니다.",
    turnedOff: "자동이 꺼졌습니다. 선택한 모델이 모든 메시지에 답변합니다.",
    answeredBy: "답변한 모델",
  },
  zh: {
    label: "自动",
    description: "Tomverse 会为每条消息挑选模型。回答的模型会显示在回复上。",
    activeSummary: "自动 — 每条消息挑选一个模型",
    turnedOn: "自动已开启。每条消息都会挑选一个模型。",
    turnedOff: "自动已关闭。你选择的模型将回答所有消息。",
    answeredBy: "回答模型",
  },
  fr: {
    label: "Auto",
    description:
      "Tomverse choisit un modèle pour chaque message. Celui qui a répondu est indiqué sur la réponse.",
    activeSummary: "Auto — un modèle est choisi par message",
    turnedOn: "Auto est activé. Un modèle sera choisi pour chaque message.",
    turnedOff: "Auto est désactivé. Le modèle que vous avez choisi répond à tous les messages.",
    answeredBy: "Répondu par",
  },
  de: {
    label: "Auto",
    description:
      "Tomverse wählt für jede Nachricht ein Modell. Das antwortende Modell steht an der Antwort.",
    activeSummary: "Auto — pro Nachricht wird ein Modell gewählt",
    turnedOn: "Auto ist an. Für jede Nachricht wird ein Modell gewählt.",
    turnedOff: "Auto ist aus. Das von dir gewählte Modell beantwortet jede Nachricht.",
    answeredBy: "Beantwortet von",
  },
  es: {
    label: "Auto",
    description:
      "Tomverse elige un modelo para cada mensaje. El que respondió aparece en la respuesta.",
    activeSummary: "Auto — se elige un modelo por mensaje",
    turnedOn: "Auto está activado. Se elegirá un modelo para cada mensaje.",
    turnedOff: "Auto está desactivado. El modelo que elegiste responde a todos los mensajes.",
    answeredBy: "Respondió",
  },
  pt: {
    label: "Auto",
    description:
      "O Tomverse escolhe um modelo para cada mensagem. O que respondeu aparece na resposta.",
    activeSummary: "Auto — um modelo é escolhido por mensagem",
    turnedOn: "Auto está ligado. Um modelo será escolhido para cada mensagem.",
    turnedOff: "Auto está desligado. O modelo que você escolheu responde a todas as mensagens.",
    answeredBy: "Respondido por",
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
