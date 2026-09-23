import { createHash } from "node:crypto";

import {
  CONSENT_COPY_KEYS,
  CONSENT_COPY_VERSIONS,
  CONSENT_COPY_LANGUAGES,
  CURRENT_CONSENT_COPY_VERSION,
  consentCopy,
  consentCopyCanonical,
  type ConsentCopyKey,
  type ConsentCopyLanguage,
} from "@/lib/emailConsentCopy";

/**
 * The hash a rendered consent device is recorded by.
 *
 * This is the value that goes into
 * `EmailPermissionEvent.evidence.candidates[].copyHash`, which is append-only
 * and outlives every deploy. So the hash has to keep naming the same words for
 * as long as the consent it evidences, which is why
 * `docs/policy/email-consent-copy-draft.md` section 9 says approved wording is
 * versioned rather than edited.
 *
 * Its own module because `node:crypto` cannot go in `lib/emailConsentCopy.ts`:
 * the locale files import that one and render in a browser.
 */

export const consentCopyHash = (
  key: ConsentCopyKey,
  language: ConsentCopyLanguage,
  version: string = CURRENT_CONSENT_COPY_VERSION
): string | null => {
  const text = consentCopy(key, language, version);
  if (text === null) return null;
  return `sha256:${createHash("sha256")
    .update(consentCopyCanonical({ version, key, language, text }))
    .digest("hex")}`;
};

/**
 * Which approved string a stored hash names, or `null`.
 *
 * The reason this file exists at all. A `notice_shown` row a year from now
 * carries a hash and nothing else about the wording; without this, the row
 * records that we asked and can never show what we asked.
 *
 * Searched across every version rather than only the current one, because the
 * interesting lookups are exactly the old ones.
 */
export const consentCopyForHash = (
  hash: string
): {
  version: string;
  key: ConsentCopyKey;
  language: ConsentCopyLanguage;
  text: string;
} | null => {
  const entry = allConsentCopyHashes().find((row) => row.hash === hash);
  if (!entry) return null;
  return {
    version: entry.version,
    key: entry.key,
    language: entry.language,
    text: entry.text,
  };
};

/** Every (version, key, language) and its hash. Used by the lookup and tests. */
export const allConsentCopyHashes = (): ReadonlyArray<{
  version: string;
  key: ConsentCopyKey;
  language: ConsentCopyLanguage;
  text: string;
  hash: string;
}> => {
  const rows: {
    version: string;
    key: ConsentCopyKey;
    language: ConsentCopyLanguage;
    text: string;
    hash: string;
  }[] = [];
  for (const { version } of CONSENT_COPY_VERSIONS) {
    for (const key of CONSENT_COPY_KEYS) {
      for (const language of CONSENT_COPY_LANGUAGES) {
        const text = consentCopy(key, language, version);
        if (text === null) continue;
        rows.push({
          version,
          key,
          language,
          text,
          hash: consentCopyHash(key, language, version)!,
        });
      }
    }
  }
  return rows;
};
