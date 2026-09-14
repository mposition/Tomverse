import "server-only";

import {
  emailTemplateDefinition,
  type RenderedEmail,
} from "@/lib/emailTemplateDefinitions";
import {
  CampaignContentError,
  readCampaignContentByLocale,
  type CampaignContentByLocale,
} from "@/lib/emailCampaignContentCore";
import { templateContentHash } from "@/lib/emailTemplateRegistry";

export type CampaignEmailPreview = RenderedEmail & {
  language: string;
  contentHash: string;
};

/** Validates every selected locale by running the real deterministic renderer. */
export const renderCampaignContent = (input: {
  templateKey: string;
  locales: readonly string[];
  contentByLocale: unknown;
}): {
  contentByLocale: CampaignContentByLocale;
  previews: CampaignEmailPreview[];
} => {
  const definition = emailTemplateDefinition(input.templateKey);
  const contentByLocale = readCampaignContentByLocale(
    input.contentByLocale,
    input.locales
  );

  const previews = input.locales.map((language) => {
    try {
      const rendered = definition.render(contentByLocale[language], language);
      if (!rendered.subject.trim() || !rendered.html.trim() || !rendered.text.trim()) {
        throw new Error("subject, HTML and plain text must all be non-empty");
      }
      return {
        language,
        ...rendered,
        contentHash: templateContentHash(rendered),
      };
    } catch (error) {
      throw new CampaignContentError(
        `Campaign content for ${language} cannot be rendered: ${
          error instanceof Error ? error.message : "unknown render error"
        }`
      );
    }
  });

  return { contentByLocale, previews };
};

export const campaignContentHashes = (input: {
  templateKey: string;
  locales: readonly string[];
  contentByLocale: unknown;
}): Record<string, string> =>
  Object.fromEntries(
    renderCampaignContent(input).previews.map((preview) => [
      preview.language,
      preview.contentHash,
    ])
  );
