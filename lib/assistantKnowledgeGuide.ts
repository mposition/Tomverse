import type { Language } from "@/lib/language";

export const ASSISTANT_KNOWLEDGE_GUIDE_ID = "assistant-knowledge";
export const ASSISTANT_KNOWLEDGE_GUIDE_PARAM = "guide";
export const ASSISTANT_KNOWLEDGE_GUIDE_PATH =
  "/guides/assistant-knowledge";
export const ASSISTANT_KNOWLEDGE_GUIDE_POSTER_PATH =
  `${ASSISTANT_KNOWLEDGE_GUIDE_PATH}/poster`;
const TOMVERSE_PUBLIC_ORIGIN = "https://tomverse.app";
export const ASSISTANT_KNOWLEDGE_GUIDE_POSTER_URL = new URL(
  ASSISTANT_KNOWLEDGE_GUIDE_POSTER_PATH,
  TOMVERSE_PUBLIC_ORIGIN
).toString();

export const ASSISTANT_KNOWLEDGE_GUIDE_CONTENT_LANGUAGES = [
  "ko",
  "en",
  "zh",
] as const;

export type AssistantKnowledgeGuideContentLanguage =
  (typeof ASSISTANT_KNOWLEDGE_GUIDE_CONTENT_LANGUAGES)[number];

/**
 * The tutorial follows the language a person selected in Tomverse, not their
 * country. Korean and Simplified Chinese have dedicated product captures;
 * every other supported locale uses the English master.
 */
export const assistantKnowledgeGuideContentLanguage = (
  language: Language
): AssistantKnowledgeGuideContentLanguage => {
  if (language === "ko" || language === "zh") return language;
  return "en";
};

/**
 * Keep reviewed tutorials on the Tomverse origin. Each master contains the UI
 * in the language it teaches and a matching voiceover; captions remain a
 * complete alternative when audio is muted.
 */
export const ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATHS: Record<
  AssistantKnowledgeGuideContentLanguage,
  string
> = {
  ko: `${ASSISTANT_KNOWLEDGE_GUIDE_PATH}/assistant-knowledge.ko.mp4`,
  en: `${ASSISTANT_KNOWLEDGE_GUIDE_PATH}/assistant-knowledge.en.mp4`,
  zh: `${ASSISTANT_KNOWLEDGE_GUIDE_PATH}/assistant-knowledge.zh.mp4`,
};

export const assistantKnowledgeGuideVideoPath = (language: Language) =>
  ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATHS[
    assistantKnowledgeGuideContentLanguage(language)
  ];

export const assistantKnowledgeGuideCaptionPath = (language: Language) => {
  const contentLanguage = assistantKnowledgeGuideContentLanguage(language);
  return `${ASSISTANT_KNOWLEDGE_GUIDE_PATH}/assistant-knowledge.${contentLanguage}.vtt`;
};

export const ASSISTANT_KNOWLEDGE_GUIDE_CAPTION_LABELS: Record<
  AssistantKnowledgeGuideContentLanguage,
  string
> = {
  ko: "한국어",
  en: "English",
  zh: "简体中文",
};

export const assistantKnowledgeGuideCaptionLabel = (language: Language) =>
  ASSISTANT_KNOWLEDGE_GUIDE_CAPTION_LABELS[
    assistantKnowledgeGuideContentLanguage(language)
  ];

export const ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_DURATION_SECONDS = 44.04;

export const ASSISTANT_KNOWLEDGE_GUIDE_STEPS = [
  "create_assistant",
  "add_knowledge",
  "start_chat",
] as const;

export type AssistantKnowledgeGuideStep =
  (typeof ASSISTANT_KNOWLEDGE_GUIDE_STEPS)[number];

/**
 * Resume from persisted profile state, never from a browser-only completion
 * marker. A missing current version and a version whose Knowledge was removed
 * both return to the add step.
 */
export const deriveAssistantKnowledgeGuideStage = ({
  isNew,
  savedKnowledgeCount,
}: {
  isNew: boolean;
  savedKnowledgeCount: number | null | undefined;
}): AssistantKnowledgeGuideStep => {
  if (isNew) return "create_assistant";
  return (savedKnowledgeCount ?? 0) > 0 ? "start_chat" : "add_knowledge";
};

export const isAssistantKnowledgeGuideValue = (value: unknown) =>
  value === ASSISTANT_KNOWLEDGE_GUIDE_ID;

export const isAssistantKnowledgeGuideRequest = (
  searchParams: Pick<URLSearchParams, "get">
) =>
  isAssistantKnowledgeGuideValue(
    searchParams.get(ASSISTANT_KNOWLEDGE_GUIDE_PARAM)
  );

const withLanguage = (path: string, language: Language) => {
  const params = new URLSearchParams({ lang: language });
  return `${path}?${params.toString()}`;
};

export const assistantKnowledgeGuideHref = (language: Language) => {
  const params = new URLSearchParams({
    lang: language,
    utm_source: "newsletter",
    utm_medium: "email",
    utm_campaign: "assistant_knowledge_launch",
  });
  return `${ASSISTANT_KNOWLEDGE_GUIDE_PATH}?${params.toString()}`;
};

export const assistantKnowledgeGuideUrl = (language: Language) =>
  new URL(
    assistantKnowledgeGuideHref(language),
    TOMVERSE_PUBLIC_ORIGIN
  ).toString();

export const assistantKnowledgeCreateHref = (language: Language) => {
  const params = new URLSearchParams({
    [ASSISTANT_KNOWLEDGE_GUIDE_PARAM]: ASSISTANT_KNOWLEDGE_GUIDE_ID,
    lang: language,
  });
  return `/settings/assistants/new?${params.toString()}`;
};

export const assistantKnowledgeProfileHref = (
  profileId: string,
  language: Language
) => {
  const base = `/settings/assistants/${encodeURIComponent(profileId)}`;
  const params = new URLSearchParams({
    [ASSISTANT_KNOWLEDGE_GUIDE_PARAM]: ASSISTANT_KNOWLEDGE_GUIDE_ID,
    lang: language,
  });
  return `${base}?${params.toString()}`;
};

export const assistantKnowledgeSignInHref = (language: Language) => {
  const callbackUrl = assistantKnowledgeCreateHref(language);
  return `${withLanguage("/auth/signin", language)}&callbackUrl=${encodeURIComponent(callbackUrl)}`;
};
