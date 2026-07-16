import type { Language } from "@/components/LanguageProvider";

const HELP_CENTRE_PATH = "/support/help-centre";
const CHAT_WORKSPACE_GUIDE_PATH = `${HELP_CENTRE_PATH}/chat-workspace`;

const withLanguage = (path: string, lang: Language, section?: string) => {
  const url = new URL(path, "https://tomverse.app");
  url.searchParams.set("lang", lang);
  url.hash = section ? `#${section.replace(/^#/, "")}` : url.hash;
  return `${url.pathname}${url.search}${url.hash}`;
};

export const helpCentreHref = (lang: Language) =>
  withLanguage(HELP_CENTRE_PATH, lang);

export const chatWorkspaceGuideHref = (
  lang: Language,
  section?: string
) => withLanguage(CHAT_WORKSPACE_GUIDE_PATH, lang, section);

