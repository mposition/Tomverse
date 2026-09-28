import {
  CONSENT_COPY_KEYS,
  consentCopy,
  type ConsentCopyKey,
  type ConsentCopyLanguage,
} from "@/lib/emailConsentCopy";

/**
 * The approved consent wording, shaped for a locale file.
 *
 * The locale files call this instead of repeating the strings, and that is the
 * whole point: these particular sentences are evidence. A hash of each one is
 * written into `EmailPermissionEvent.evidence.candidates[].copyHash` when a
 * notice is rendered, and that row is append-only -- so a second copy in
 * `locales/` would be a second place for the words to change, and when they
 * changed there the hash would stop naming anything.
 *
 * It reads as an ordinary locale section to whoever renders it, which is
 * correct: the difference is not in how it is displayed, it is in what may
 * edit it. `docs/policy/email-consent-copy-draft.md` section 10 is the edit
 * procedure, and it is not "change the string".
 */
export const consentCopyForLanguage = (
  language: ConsentCopyLanguage
): Readonly<Record<ConsentCopyKey, string>> =>
  Object.freeze(
    Object.fromEntries(
      CONSENT_COPY_KEYS.map((key) => {
        const text = consentCopy(key, language);
        if (text === null) {
          // An empty string here renders an empty checkbox label, and
          // `consentCopyHash()` answers null for the same gap -- so the screen
          // would ask for consent with nothing written on it and the ledger
          // would have no hash to record. Both silent. The table is complete,
          // so a gap is a bug in a new version and this is where it surfaces.
          throw new Error(
            `No approved consent copy for ${key} in ${language}.`
          );
        }
        return [key, text];
      })
    ) as Record<ConsentCopyKey, string>
  );
