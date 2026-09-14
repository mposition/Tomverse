/**
 * Campaign-authored content, kept separate from audience selection.
 *
 * A campaign event carries every approved locale because one fan-out may reach
 * people with different language settings. Each delivery stores only the
 * payload for its resolved language, so seven translations are not duplicated
 * into every encrypted snapshot.
 */

export const LOCALIZED_CAMPAIGN_PAYLOAD_KIND = "localized_campaign_v1";

export type CampaignContentByLocale = Record<string, Record<string, unknown>>;

export type LocalizedCampaignEventPayload = {
  kind: typeof LOCALIZED_CAMPAIGN_PAYLOAD_KIND;
  locales: string[];
  contentByLocale: CampaignContentByLocale;
};

export class CampaignContentError extends Error {
  readonly code = "CAMPAIGN_CONTENT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CampaignContentError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Reads exactly the locales a campaign claims to send.
 *
 * Extra keys are dropped. A stale translation must not enter an approval
 * digest simply because a removed locale is still present in submitted JSON.
 */
export const readCampaignContentByLocale = (
  raw: unknown,
  locales: readonly string[]
): CampaignContentByLocale => {
  if (!isRecord(raw)) {
    throw new CampaignContentError(
      "Campaign content must be an object keyed by locale."
    );
  }

  const content: CampaignContentByLocale = {};
  for (const locale of locales) {
    const payload = raw[locale];
    if (!isRecord(payload)) {
      throw new CampaignContentError(
        `Campaign content for ${locale} is missing or is not an object.`
      );
    }
    content[locale] = payload;
  }
  return content;
};

export const localizedCampaignEventPayload = (input: {
  locales: readonly string[];
  contentByLocale: CampaignContentByLocale;
}): LocalizedCampaignEventPayload => ({
  kind: LOCALIZED_CAMPAIGN_PAYLOAD_KIND,
  locales: [...input.locales],
  contentByLocale: input.contentByLocale,
});

export const isLocalizedCampaignEventPayload = (
  raw: unknown
): raw is LocalizedCampaignEventPayload => {
  if (!isRecord(raw) || raw.kind !== LOCALIZED_CAMPAIGN_PAYLOAD_KIND) return false;
  if (!Array.isArray(raw.locales) || !isRecord(raw.contentByLocale)) return false;
  const contentByLocale = raw.contentByLocale;
  return raw.locales.every(
    (locale) => typeof locale === "string" && isRecord(contentByLocale[locale])
  );
};

/**
 * Resolves the language and compact payload one delivery snapshots.
 *
 * Unsupported recipient languages fall back to approved English, then to the
 * campaign's first approved locale. They never render an unapproved locale.
 */
export const deliveryContentForLanguage = (
  raw: unknown,
  preferredLanguage: string
): { language: string; payload: Record<string, unknown> } => {
  if (!isLocalizedCampaignEventPayload(raw)) {
    if (!isRecord(raw)) {
      throw new CampaignContentError("The email event payload is not an object.");
    }
    return { language: preferredLanguage, payload: raw };
  }

  const language = raw.contentByLocale[preferredLanguage]
    ? preferredLanguage
    : raw.contentByLocale.en
      ? "en"
      : raw.locales[0];
  const payload = language ? raw.contentByLocale[language] : undefined;
  if (!language || !payload) {
    throw new CampaignContentError(
      "The campaign event has no approved locale payload."
    );
  }
  return { language, payload };
};
