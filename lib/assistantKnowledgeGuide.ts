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

/**
 * The Runway-produced tutorial will live on a Tomverse origin and be set here
 * once the reviewed export exists. Until then the page renders the complete,
 * keyboard-accessible interactive walkthrough instead of a broken player.
 */
export const ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATH: string | null = null;

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
