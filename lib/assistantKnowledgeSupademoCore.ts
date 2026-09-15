import type { AssistantKnowledgeGuideContentLanguage } from "@/lib/assistantKnowledgeGuide";

export type AssistantKnowledgeSupademoEmbeds = Partial<
  Record<AssistantKnowledgeGuideContentLanguage, string>
>;

const isSupademoHost = (hostname: string) =>
  hostname === "supademo.com" || hostname.endsWith(".supademo.com");

/**
 * Supademo embed URLs are public delivery URLs, but still cross an iframe
 * boundary. Refuse non-HTTPS and lookalike hosts before the value reaches the
 * client or the page CSP.
 */
export const parseAssistantKnowledgeSupademoUrl = (
  value: string | null | undefined
): string | null => {
  const candidate = value?.trim();
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      !isSupademoHost(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
};

export const assistantKnowledgeSupademoEmbeds = (input: {
  ko?: string | null;
  en?: string | null;
  zh?: string | null;
}): AssistantKnowledgeSupademoEmbeds =>
  Object.fromEntries(
    (["ko", "en", "zh"] as const)
      .map((language) => [
        language,
        parseAssistantKnowledgeSupademoUrl(input[language]),
      ])
      .filter((entry): entry is [AssistantKnowledgeGuideContentLanguage, string] =>
        Boolean(entry[1])
      )
  );
